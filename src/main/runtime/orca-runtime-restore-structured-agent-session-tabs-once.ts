// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from './orca-runtime-get-structured-agent-session-create-support'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'
import { seedStructuredAgentSessionTabIndex } from './structured-agent-session-tab-index-seed'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import { DEFAULT_REPO_SEARCH_REFS_LIMIT } from './orca-runtime-postlude'
import type { Repo } from '../../shared/repo-types'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import {
  getLocalProjectGhExecOptions,
  resolveLocalProjectRuntimeForRepo,
  type LocalProjectGhExecOptions
} from '../project-runtime-git-options'
import { getAgentLaunchPlatformForRepo } from './runtime-agent-launch-resolution'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { LayoutCommandReply } from '../../shared/workspace-layout/workspace-layout-command-types'

type RestoredSessionTab = { workspaceId: string; sessionId: string; agent: StructuredAgentId }

// Every session here is of an agent this host registered: its store holds no other agent's records.
function restoredSessionTabs(
  host: ReturnType<typeof getStructuredAgentSessionHost>
): RestoredSessionTab[] {
  return (host?.listSessionTabs() ?? []).map((session) => {
    let sessionId = session.sessionId
    while (sessionId.startsWith('agent-session:')) {
      sessionId = sessionId.slice('agent-session:'.length)
    }
    return { ...session, agent: session.agent, sessionId }
  })
}

export class OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce extends OrcaRuntimeWithGetStructuredAgentSessionCreateSupport {
  /** Workspaces whose restored chats the layout refused: only a later scan adds them to the catalog. */
  private readonly restoredChatWorkspacesAwaitingCatalog = new Set<string>()

  protected async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    await this.prepareStructuredAgentSessionStartupRestoration()
    const host = getStructuredAgentSessionHost()
    const persistedVisibleIndex =
      typeof host?.getPersistedVisibleSessionTabIndex === 'function'
        ? host.getPersistedVisibleSessionTabIndex()
        : { present: false, sessionIds: [] }
    const profileIds = collectSavedStructuredAgentSessionIds(
      this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null
    )
    const targets = persistedVisibleIndex.present ? persistedVisibleIndex.sessionIds : profileIds
    await host?.restoreReadableSessions(targets)
    const restored = restoredSessionTabs(host)
    await seedStructuredAgentSessionTabIndex(
      host,
      targets,
      restored.map((session) => session.sessionId)
    )
    // Past the seed, projecting records nothing; a chat the loaded layout already shows is kept.
    for (const session of restored) {
      this.projectRestoredStructuredAgentSessionTab(session)
    }
    const wasUnverifiable = this.structuredAgentSessionInventoryUnverifiable
    // No host means no one can say which chats exist; with none on disk, empty is the answer.
    this.structuredAgentSessionInventoryUnverifiable =
      !host && this.hasPersistedStructuredAgentSessionStore()
    // This restore published quietly; subscribers still hold the frames that said "cannot tell".
    if (wasUnverifiable && !this.structuredAgentSessionInventoryUnverifiable) {
      this.notifyMobileSessionTabSnapshots()
    }
  }

  /** A scan added these worktrees to the catalog: chats restored before it open now, as on main. */
  restoreStructuredAgentSessionTabsForJoinedWorkspaces(keys: readonly string[]): void {
    const joined = new Set(
      keys.filter((key) => this.restoredChatWorkspacesAwaitingCatalog.delete(key))
    )
    if (joined.size === 0) {
      return
    }
    // Re-read the host: a chat closed while its worktree was unlisted stays closed.
    for (const session of restoredSessionTabs(getStructuredAgentSessionHost())) {
      if (joined.has(session.workspaceId)) {
        this.projectRestoredStructuredAgentSessionTab(session)
      }
    }
  }

  private projectRestoredStructuredAgentSessionTab(session: RestoredSessionTab): void {
    const reply = this.projectStructuredAgentSessionTab({
      ...session,
      activate: false,
      notify: false
    })
    if (!reply.ok && reply.code === 'workspace_not_found') {
      this.restoredChatWorkspacesAwaitingCatalog.add(session.workspaceId)
    }
  }

  async publishStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: StructuredAgentId
    activate: boolean
    notify?: boolean
    /** The host tab id a create reserved; a session that already has a tab keeps its own. */
    tabId?: string
  }): Promise<void> {
    const host = getStructuredAgentSessionHost()
    if (typeof host?.setSessionTabVisibility === 'function') {
      // The restore index is bookkeeping: one that cannot be written (a newer Orca's records, a
      // failing disk) is reported, and the tab still opens.
      await host
        .setSessionTabVisibility(input.sessionId, true, ...(input.tabId ? [input.tabId] : []))
        .catch((error: unknown) => {
          host.deps.logger.warn('recording an opened chat tab failed', {
            scope: 'tab-visibility-open',
            sessionId: input.sessionId,
            error
          })
        })
    }
    this.projectStructuredAgentSessionTab(input)
  }

  /** The chat's tab in the runtime's layout, added once. Records nothing: the caller owns the store write. */
  projectStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: StructuredAgentId
    activate: boolean
    notify?: boolean
  }): LayoutCommandReply {
    // A new chat tab opens in the group the desktop view shows, as the window opens it.
    const reply = this.applyTranslatedLayoutCommands([
      {
        type: 'openAgentSessionTab',
        workspace: input.workspaceId,
        sessionId: input.sessionId,
        agent: input.agent,
        ...this.desktopActiveGroup(input.workspaceId)
      }
    ])
    const tabId = reply.ok ? reply.tabId : undefined
    if (input.activate && tabId) {
      this.focusInDesktopView(input.workspaceId, { tabId })
    }
    return reply
  }

  async inspectTerminalProcess(
    terminalSelector: string,
    options?: { expectedIncarnationId?: string; scanChildProcesses?: boolean }
  ): Promise<PtyProcessInspection> {
    const leaf = this.resolveLiveLeafForHandle(terminalSelector)
    if (!leaf?.ptyId || !this.ptyController) {
      throw new Error('terminal_gone')
    }
    if (this.ptyController.inspectProcess) {
      // Preserve the legacy one-argument call shape when no incarnation
      // fence was requested; some providers use arity to distinguish the
      // compatibility path from the fenced remote inspection.
      const inspection =
        options === undefined
          ? await this.ptyController.inspectProcess(leaf.ptyId)
          : await this.ptyController.inspectProcess(leaf.ptyId, options)
      const evidence = inspection.foregroundProcessEvidence
      // The runtime handle is the request identity on this wire; keep the
      // host-owned leaf PTY id out of the client-facing comparison.
      const relayPtyId = parseAppSshPtyId(leaf.ptyId)?.relayPtyId
      const evidenceBelongsToLeaf =
        evidence !== undefined && (evidence.ptyId === leaf.ptyId || evidence.ptyId === relayPtyId)
      return evidenceBelongsToLeaf
        ? { ...inspection, foregroundProcessEvidence: { ...evidence, ptyId: terminalSelector } }
        : inspection
    }
    const foregroundProcess = await this.ptyController.getForegroundProcess(leaf.ptyId)
    const hasChildProcesses = (await this.ptyController.hasChildProcesses?.(leaf.ptyId)) ?? false
    return { foregroundProcess, hasChildProcesses }
  }

  async searchRepoRefs(
    repoSelector: string,
    query: string,
    limit = DEFAULT_REPO_SEARCH_REFS_LIMIT,
    includeQualifiedRefs = true
  ): Promise<RuntimeRepoSearchRefs> {
    return this.repositoryRefQueries.search(repoSelector, query, limit, includeQualifiedRefs)
  }

  protected async resolveHostedReviewTarget(args: {
    repoSelector: string
    worktreeSelector?: string
  }): Promise<{ repo: Repo; repoPath: string }> {
    const repo = await this.resolveRepoSelector(args.repoSelector)
    if (!args.worktreeSelector) {
      return { repo, repoPath: repo.path }
    }

    const worktree = await this.resolveWorktreeSelector(args.worktreeSelector)
    if (worktree.repoId !== repo.id) {
      throw new Error('Access denied: worktree does not belong to repository')
    }
    return { repo, repoPath: worktree.path }
  }

  protected getHostedReviewExecutionOptions(
    repo: Repo,
    admissionTier?: GitAdmissionTier
  ):
    | { localGitExecOptions: LocalProjectGhExecOptions & { admissionTier?: GitAdmissionTier } }
    | undefined {
    const localGitOptions = {
      ...this.getLocalGitExecutionOptionArgs(repo)[0],
      ...(admissionTier && { admissionTier })
    }
    return Object.keys(localGitOptions).length > 0
      ? { localGitExecOptions: localGitOptions }
      : undefined
  }

  protected getLocalGitExecutionOptionArgs(repo: Repo): [] | [LocalProjectGhExecOptions] {
    const localGitOptions = getLocalProjectGhExecOptions(this.requireStore(), repo)
    return Object.keys(localGitOptions).length > 0 ? [localGitOptions] : []
  }

  protected getAgentLaunchPlatformForRepo(repo: Repo): NodeJS.Platform {
    const projectRuntime = repo.connectionId
      ? undefined
      : resolveLocalProjectRuntimeForRepo(this.requireStore(), repo)
    return getAgentLaunchPlatformForRepo(repo, projectRuntime)
  }

  protected getAgentLaunchPlatformForWorkspace(
    scope: TerminalWorkspaceLaunchScope
  ): NodeJS.Platform {
    if (scope.repo) {
      return this.getAgentLaunchPlatformForRepo(scope.repo)
    }
    if (scope.connectionId) {
      return isWindowsAbsolutePathLike(scope.path) ? 'win32' : 'linux'
    }
    return isWslUncPath(scope.path) ? 'linux' : process.platform
  }
}
