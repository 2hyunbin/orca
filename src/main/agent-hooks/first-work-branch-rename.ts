// On first agent work in a fresh workspace, replace the provisional branch Orca created with a short work-derived name.
import { sameBranchRenameGrant, type BranchRenameGrant } from '../worktree-generated-branch'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import { getRepoIdFromWorktreeId, splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { humanizeBranchSlug, stripConfiguredBranchPrefix } from '../../shared/branch-name-from-work'
import { getCommitMessageModelDiscoveryHostKey } from '../../shared/commit-message-host-key'
import { computeBranchName, getConfiguredBranchPrefix } from '../ipc/worktree-branch-name'
import { gitExecFileAsync } from '../git/runner'
import { resolveLocalGitUsername } from '../git/git-username'
import { resolveGitRouteForHost } from '../providers/execution-host-provider-dispatch'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import {
  probeBranchUpstream,
  readCurrentBranch,
  renameCurrentBranch,
  resolveUniqueBranchName,
  type GitExec
} from '../git/branch-rename'
import {
  generateBranchNameFromContext,
  resolveTextGenerationParams
} from '../text-generation/commit-message-text-generation'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { AgentGenerationFailureOutput } from '../text-generation/agent-failure-output'
import { resolveGenerationTarget } from './first-work-generation-target'
import { runFolderWorkspaceTitleAutoRename } from './first-work-workspace-title-rename'
import { isWslMoveRepoBlocked } from '../persistence/moving-wsl-projects/wsl-move-background-backoff'

export type FirstWorkBranchRenameEvent = {
  paneKey: string
  /** Agent-echoed worktree id; unreliable, used only as a fallback. */
  worktreeId: string | undefined
  tabId: string | undefined
  state: string
  prompt: string | undefined
  assistantMessage: string | undefined
  isReplay: boolean | undefined
}

export type FirstWorkBranchRenameDeps = {
  getSettings: () => Parameters<typeof resolveTextGenerationParams>[0] &
    Parameters<typeof getConfiguredBranchPrefix>[0] &
    Partial<Pick<GlobalSettings, 'autoRenameBranchFromWork'>>
  getRepo: (repoId: string) => Repo | undefined
  getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined
  /** Current sidebar display name for the worktree, if one is stored. */
  getCurrentDisplayName: (worktreeId: string) => string | undefined
  /** Current workspace path for non-git folder workspaces. */
  getFolderWorkspacePath?: (worktreeId: string) => string | undefined
  /** True while a WSL move is taking the folder workspace, or the WSL host owns it. */
  isFolderWorkspaceWslMoveBlocked?: (worktreeId: string) => boolean
  /** True while a workspace title is waiting for the first agent message. */
  isPendingFirstAgentMessageRename?: (worktreeId: string) => boolean
  getBranchRenameGrant: (worktreeId: string) => BranchRenameGrant | undefined
  clearBranchRenameGrant: (worktreeId: string, grant: BranchRenameGrant) => void
  isDisplayNamePinned: (worktreeId: string, grant?: BranchRenameGrant) => boolean
  /** Persist a new sidebar display name for the worktree. */
  setDisplayName: (worktreeId: string, displayName: string) => void
  /** Align the on-disk folder with the new branch leaf (best-effort, local-only). */
  renameWorktreeFolder?: (worktreeId: string, newLeaf: string) => Promise<boolean>
  /** Record (or clear with null) an auto-rename failure for the sidebar "rename failed" badge; `failureOutput` carries bounded CLI output for on-demand display. */
  setRenameError: (
    worktreeId: string,
    error: string | null,
    failureOutput?: AgentGenerationFailureOutput | null
  ) => void
  /** Authoritative tab→worktree resolution from the session's tab map. */
  resolveWorktreeIdForTab: (tabId: string) => string | undefined
  /** Invalidate caches + notify the renderer so the new branch name surfaces. */
  onRenamed: (repoId: string) => void
}

// inFlight blocks concurrent generation; settled caches definitive verdicts (transient bails stay unsettled to retry later).
const inFlightWorktreeIds = new Set<string>()
const settledWorktreeIds = new Set<string>()
export const FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT = 500

/** Test seam: clear the per-process dedupe sets. */
export function resetFirstWorkBranchRenameState(): void {
  inFlightWorktreeIds.clear()
  settledWorktreeIds.clear()
}

function rememberSettledWorktreeId(worktreeId: string): void {
  // Why: worktree ids are unbounded over a long session; evict oldest to bound memory (costs a rare re-probe).
  settledWorktreeIds.delete(worktreeId)
  settledWorktreeIds.add(worktreeId)
  while (settledWorktreeIds.size > FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT) {
    const oldest = settledWorktreeIds.values().next().value
    if (typeof oldest !== 'string') {
      return
    }
    settledWorktreeIds.delete(oldest)
  }
}

export async function maybeAutoRenameBranchOnFirstWork(
  event: FirstWorkBranchRenameEvent,
  deps: FirstWorkBranchRenameDeps
): Promise<void> {
  // Cheap gates first — the signal must be a live "work has begun" event.
  if (event.isReplay || event.state !== 'working') {
    return
  }
  // Resolve from the tab (authoritative); the agent-echoed worktreeId isn't present on every event.
  const tabId = parsePaneKey(event.paneKey)?.tabId ?? event.tabId
  const worktreeId = (tabId ? deps.resolveWorktreeIdForTab(tabId) : undefined) ?? event.worktreeId
  if (!worktreeId) {
    return
  }
  const settledKey = `${worktreeId}:${deps.getBranchRenameGrant(worktreeId)?.instanceId ?? ''}`
  // Short-circuit settled/in-flight worktrees before any logging or work.
  if (settledWorktreeIds.has(settledKey) || inFlightWorktreeIds.has(worktreeId)) {
    return
  }
  const prompt = event.prompt?.trim()
  if (!prompt) {
    return
  }
  inFlightWorktreeIds.add(worktreeId)
  try {
    // settled = definitive verdict (renamed/ineligible); false = transient bail to retry later.
    const settled = await runAutoRename(worktreeId, prompt, event.assistantMessage, deps)
    if (settled) {
      rememberSettledWorktreeId(settledKey)
    }
  } catch (error) {
    // Why: best-effort convenience; a failure must never disrupt the user's agent, so swallow after logging.
    console.warn('[auto-branch-rename] rename attempt failed:', error)
  } finally {
    inFlightWorktreeIds.delete(worktreeId)
  }
}

/** Returns true for a definitive verdict (renamed or permanently ineligible → stop re-probing), false for a transient bail worth retrying. */
async function runAutoRename(
  worktreeId: string,
  prompt: string,
  assistantMessage: string | undefined,
  deps: FirstWorkBranchRenameDeps
): Promise<boolean> {
  // `stop` = permanent skip (logs which gate bailed); `retry` = transient; `clearError` drops a stale "rename failed" badge on a benign final state.
  const stop = (reason: string, clearError = false): true => {
    if (clearError) {
      deps.setRenameError(worktreeId, null)
    }
    console.info(`[auto-branch-rename] skip (${reason}) for ${worktreeId}`)
    return true
  }
  const retry = (reason: string): false => {
    console.info(`[auto-branch-rename] retry-later (${reason}) for ${worktreeId}`)
    return false
  }

  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    if (!deps.getSettings().autoRenameBranchFromWork) {
      return retry('automatic naming disabled')
    }
    return runFolderWorkspaceTitleAutoRename(
      worktreeId,
      prompt,
      assistantMessage,
      deps,
      stop,
      retry
    )
  }

  const repo = deps.getRepo(getRepoIdFromWorktreeId(worktreeId))
  // Why: folder-workspace ids carry a synthetic `::workspace:<uuid>` suffix that's not a real dir; resolve to the backing folder for Git's cwd.
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  if (!repo || !parsed) {
    return stop('unresolved repo or worktree id')
  }
  if (isFolderRepo(repo)) {
    return stop('folder project has no branch to rename', true)
  }
  const worktreePath = parsed.worktreePath
  // Before any git command; retry keeps the rename pending until the move settles.
  if (isWslMoveRepoBlocked(repo)) {
    return retry('a WSL move is taking the project')
  }

  // Why: a runtime row's connectionId names the server's own SSH target; that host owns the branch, never this client.
  const route = resolveGitRouteForHost(getRepoExecutionHostId(repo))
  if (route.kind === 'runtime') {
    return stop(`branch is owned by ${route.hostId}`)
  }
  if (route.kind === 'ssh') {
    return retry('ssh provider unavailable')
  }
  const exec: GitExec = (args) => gitExecFileAsync(args, { cwd: worktreePath })

  const grant = deps.getBranchRenameGrant(worktreeId)
  if (!grant) {
    return stop('no generated branch grant', true)
  }
  const abandon = (reason: string): true => {
    try {
      deps.clearBranchRenameGrant(worktreeId, grant)
    } catch (error) {
      console.warn('[auto-branch-rename] could not clear branch grant:', error)
    }
    return stop(reason, true)
  }
  const currentBranch = await readCurrentBranch(exec)
  if (!currentBranch) {
    return retry('no checked-out branch')
  }
  if (currentBranch !== grant.branch) {
    return abandon('generated branch is no longer current')
  }
  if (!deps.getSettings().autoRenameBranchFromWork) {
    return retry('automatic naming disabled')
  }
  // Never rewrite a branch that's already been published.
  const upstreamProbe = await probeBranchUpstream(exec)
  if (upstreamProbe.outcome === 'has-upstream') {
    return abandon(`branch "${currentBranch}" already has an upstream`)
  }
  if (upstreamProbe.outcome === 'probe-failed') {
    // Why: settling an unreadable probe as "has upstream" made this silent + permanent via the settled cache (issue #7808).
    const probeError = upstreamProbe.message.replace(/\s+/g, ' ').trim()
    deps.setRenameError(
      worktreeId,
      `Could not check whether the branch is published: ${probeError}`
    )
    return retry(`upstream probe failed: ${probeError}`)
  }

  const settings = deps.getSettings()
  const hostKey = getCommitMessageModelDiscoveryHostKey(null)
  const resolvedParams = resolveTextGenerationParams(settings, hostKey, 'branchName', repo)
  if (!resolvedParams.ok) {
    // Why: a generation-step failure (vs a benign skip) is user-actionable, so surface it on the card.
    deps.setRenameError(worktreeId, resolvedParams.error)
    return retry(`no generation agent: ${resolvedParams.error}`)
  }
  const params = resolvedParams.params

  const target = await resolveGenerationTarget(worktreePath, params.agentId, deps)
  if (!target) {
    deps.setRenameError(worktreeId, 'Could not prepare the branch-name generation environment.')
    return retry('could not prepare generation environment')
  }

  const generated = await generateBranchNameFromContext(
    { firstPrompt: prompt, assistantMessage },
    params,
    target
  )
  // Generation takes seconds; a move may have started meanwhile.
  if (isWslMoveRepoBlocked(repo)) {
    return retry('a WSL move started during generation')
  }
  if (!generated.success) {
    // Transient failure: retry on a later event; skip the badge for a user-canceled generation.
    if (!generated.canceled) {
      deps.setRenameError(worktreeId, generated.error, generated.failureOutput ?? null)
    }
    return retry(`generation failed: ${generated.error}`)
  }

  const username = (await resolveLocalGitUsername(repo.path)) || null
  // The model sometimes echoes the configured prefix (e.g. `tmchow/...`); strip it to avoid double-prefixing.
  const slug = stripConfiguredBranchPrefix(
    generated.slug,
    getConfiguredBranchPrefix(settings, username)
  )
  // Prefix-only output strips to empty; renaming would just re-add the prefix (`tmchow/tmchow`), so skip.
  if (!slug) {
    return abandon('model produced only the configured prefix')
  }
  const newBranch = await resolveUniqueBranchName(
    exec,
    slug,
    // Use the non-throwing builder here: the prefix was already validated at
    // worktree-create time, and this best-effort background rename has its own
    // retry/stop handling, so it must not throw on prefix issues.
    (slugLeaf) => computeBranchName(slugLeaf, settings, username),
    currentBranch
  )
  if (!newBranch || newBranch === currentBranch) {
    // No distinct name is terminal and benign, so clear any stale failure badge from a prior transient attempt.
    return abandon(`no distinct unique branch name for slug "${slug}"`)
  }

  // Revalidate after all name lookups, immediately before the mutation.
  if (isWslMoveRepoBlocked(repo)) {
    return retry('a WSL move started before the branch rename')
  }
  const finalProbe = await probeBranchUpstream(exec)
  if (finalProbe.outcome === 'has-upstream') {
    return abandon('branch was published')
  }
  if (finalProbe.outcome === 'probe-failed') {
    return retry('publication check failed')
  }
  if ((await readCurrentBranch(exec)) !== currentBranch) {
    return abandon('branch changed')
  }
  if (!sameBranchRenameGrant(deps.getBranchRenameGrant(worktreeId), grant)) {
    return stop('branch grant changed', true)
  }
  if (!deps.getSettings().autoRenameBranchFromWork) {
    return retry('automatic naming disabled')
  }
  await renameCurrentBranch(exec, newBranch, currentBranch)
  abandon('generated branch renamed')

  // resolveUniqueBranchName may append a collision suffix (`-2`, …), so derive names from the resolved leaf, not the slug.
  const newBranchLeaf = newBranch.slice(newBranch.lastIndexOf('/') + 1)
  // Branch ownership never grants permission to replace a pinned sidebar label.
  const currentDisplayName = deps.getCurrentDisplayName(worktreeId)
  const newDisplayName = humanizeBranchSlug(newBranchLeaf)
  const updateDisplay = !deps.isDisplayNamePinned(worktreeId, grant)
  if (updateDisplay) {
    deps.setDisplayName(worktreeId, newDisplayName)
  }

  // A successful rename clears any stale generation-failure surfaced earlier.
  deps.setRenameError(worktreeId, null)

  // Best-effort local-only folder align, after setDisplayName so the new name rides into the migrated identity; a failure must never undo the landed rename.
  let folderRenamed = false
  // The branch rename landed, but a move now taking the project must not see its folder moved.
  const folderBlocked = isWslMoveRepoBlocked(repo)
  if (deps.renameWorktreeFolder && !folderBlocked) {
    try {
      folderRenamed = await deps.renameWorktreeFolder(worktreeId, newBranchLeaf)
    } catch (error) {
      console.warn('[auto-branch-rename] folder rename failed:', error)
    }
  }

  // A folder rename already notified the renderer, so a second onRenamed would just re-list redundantly.
  if (!folderRenamed) {
    deps.onRenamed(repo.id)
  }
  const displayLog = updateDisplay
    ? `display "${currentDisplayName ?? ''}" -> "${newDisplayName}"`
    : `display kept ("${currentDisplayName}")`
  // The branch already has its new name, so a move that skipped the folder still settles the rename.
  const folderLog = folderRenamed
    ? '; folder renamed'
    : folderBlocked
      ? '; folder kept (a WSL move started)'
      : ''
  console.info(
    `[auto-branch-rename] renamed ${currentBranch} -> ${newBranch}; ${displayLog}${folderLog}`
  )
  return true
}
