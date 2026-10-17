/**
 * Moves running Claude terminal sessions onto a newly selected Claude account.
 *
 * Why restart + resume is enough: every Orca terminal's `claude` shell function
 * reads the selected account's config folder at launch, so relaunching
 * `claude --resume <id>` in the same pane lands on the new account with the
 * conversation intact. Native chat sessions are not terminal panes and are
 * never touched here.
 */
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess,
  type RuntimeTerminalProcessInspection
} from '@/runtime/runtime-terminal-inspection'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { isClientOnlyUnverifiableInspection } from '../../../shared/terminal-process-inspection'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { resolveAgentAccountRestartResumeStartup } from './agent-account-restart-startup'
import { getRendererAppPlatform } from './renderer-app-platform'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  resolveCodexPaneSelectionLane
} from './codex-pane-selection-lane'

export type ClaudeSessionMoveCandidate = {
  ptyId: string
  tabId: string
  leafId: string
}

function isClaudeProcess(processName: string | null): boolean {
  return (
    processName !== null &&
    (recognizeAgentProcess(processName)?.agent === 'claude' ||
      isAgentForegroundWrapperProcess(processName))
  )
}

/**
 * Whether Claude, not the shell or another program, holds the pane's foreground.
 *
 * Why the confirm fallback: cached foreground names flap to the shell, and the
 * native macOS install reads as its version folder (`2.1.x`), not `claude`.
 */
async function isClaudeInForeground(
  ptyId: string,
  inspection: RuntimeTerminalProcessInspection
): Promise<boolean> {
  if (isClientOnlyUnverifiableInspection(inspection)) {
    return false
  }
  if (isClaudeProcess(inspection.foregroundProcess)) {
    return true
  }
  return isClaudeProcess(await confirmRuntimeTerminalForegroundProcess(ptyId))
}

/** Whether the pane's Claude is mid-turn; 'blocked' is a permission prompt, whose tool call a restart drops. */
export function isClaudePaneMidTurn(state: AppState, paneKey: string): boolean {
  const entry = state.agentStatusByPaneKey[paneKey]
  return entry?.agentType === 'claude' && (entry.state === 'working' || entry.state === 'blocked')
}

function normalizeFolder(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return getRendererAppPlatform() === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * The Claude account a session runs on, read from where Claude writes its transcript
 * (`<CLAUDE_CONFIG_DIR>/projects/...`): a managed account's folder, else System default
 * (null). Undefined when the hook reported no transcript, so the caller cannot know.
 */
export function resolveClaudeSessionAccountId(
  transcriptPath: string | undefined,
  accounts: readonly ClaudeManagedAccount[]
): string | null | undefined {
  const transcript = transcriptPath ? normalizeFolder(transcriptPath) : ''
  const projectsIndex = transcript.lastIndexOf('/projects/')
  if (projectsIndex <= 0) {
    return undefined
  }
  const configDir = transcript.slice(0, projectsIndex)
  const account = accounts.find((candidate) =>
    [candidate.managedAuthPath, candidate.wslLinuxAuthPath].some(
      (folder) => folder && normalizeFolder(folder) === configDir
    )
  )
  return account ? account.id : null
}

/**
 * Finds local terminal panes running a resumable Claude session in the lane the
 * account switch wrote.
 *
 * Why remote owners return nothing: a relay or SSH machine keeps its own Claude
 * login, so a local switch cannot strand those sessions.
 */
export async function findMovableClaudeSessions(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  /** Only sessions known to run on this account count; null is System default. */
  fromAccountId: string | null
}): Promise<ClaudeSessionMoveCandidate[]> {
  if (args.owner.kind !== 'local') {
    return []
  }
  const state = useAppStore.getState()
  const isLaneInScope = getCodexAccountSwitchLaneMatcher({
    owner: args.owner,
    target: args.target
  })
  const candidates: ClaudeSessionMoveCandidate[] = []
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const boundPtyIds = state.ptyIdsByTabId[tab.id] ?? []
      const leaves = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      for (const [leafId, ptyId] of Object.entries(leaves)) {
        if (
          !ptyId ||
          !isTerminalLeafId(leafId) ||
          !boundPtyIds.includes(ptyId) ||
          isForeignMachineCodexPtyId(ptyId)
        ) {
          continue
        }
        const entry = state.agentStatusByPaneKey[makePaneKey(tab.id, leafId)]
        const session = normalizeAgentProviderSession(entry?.providerSession)
        if (
          entry?.agentType !== 'claude' ||
          entry.structuredHostOwned ||
          resolveClaudeSessionAccountId(
            session?.transcriptPath,
            state.settings?.claudeManagedAccounts ?? []
          ) !== args.fromAccountId
        ) {
          continue
        }
        if (!isLaneInScope(resolveCodexPaneSelectionLane({ state, tab, ptyId }).laneKey)) {
          continue
        }
        const resumeStartup = resolveAgentAccountRestartResumeStartup('claude', {
          tabId: tab.id,
          leafId,
          worktreeId,
          shellOverride: tab.shellOverride
        })
        if (resumeStartup) {
          candidates.push({ ptyId, tabId: tab.id, leafId })
        }
      }
    }
  }
  const inForeground = await Promise.all(
    candidates.map((candidate) =>
      inspectRuntimeTerminalProcess(candidate.ptyId).then(
        (inspection) => isClaudeInForeground(candidate.ptyId, inspection),
        () => false
      )
    )
  )
  return candidates.filter((_, index) => inForeground[index])
}
