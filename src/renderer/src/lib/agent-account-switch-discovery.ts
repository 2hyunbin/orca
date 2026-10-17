/**
 * Finds the running agent terminal sessions an account switch can move, from the account each
 * session's transcript says it runs on. Agent-neutral: the AccountSwitchAgent says how a
 * transcript maps to an account and how to confirm its process holds the pane.
 */
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { resolveAgentAccountRestartResumeStartup } from './agent-account-restart-startup'
import type { AccountSwitchSession } from './agent-account-switch-sessions'
import type { AccountSwitchAgent } from './agent-account-switch-agent'
import { getRendererAppPlatform } from './renderer-app-platform'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  resolveCodexPaneSelectionLane
} from './codex-pane-selection-lane'

export type AgentSwitchScope = {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  /** Set when the switch cleared every WSL distro slot at once. */
  clearsEveryWslDistro?: boolean
}

export function normalizeAgentHomeFolder(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return getRendererAppPlatform() === 'win32' ? slashed.toLowerCase() : slashed
}

/** The home folder a transcript was written under: the part before its last `/<dirName>/`. */
export function transcriptHomeFolder(
  transcriptPath: string | undefined,
  dirName: string
): string | undefined {
  const transcript = transcriptPath ? normalizeAgentHomeFolder(transcriptPath) : ''
  const index = transcript.lastIndexOf(`/${dirName}/`)
  return index > 0 ? transcript.slice(0, index) : undefined
}

/** The account whose home folders include `home`, by normalized path. */
export function findAccountByHomeFolder<T>(
  home: string,
  accounts: readonly T[],
  folders: (account: T) => readonly (string | null | undefined)[]
): T | undefined {
  return accounts.find((account) =>
    folders(account).some((folder) => folder && normalizeAgentHomeFolder(folder) === home)
  )
}

type LocalAgentPane = {
  worktreeId: string
  tab: TerminalTab
  leafId: string
  ptyId: string
  accountId: string | null | undefined
}

/** This machine's terminal (not structured) sessions of `reader.agent` in the switch's lane. */
function* localAgentPanesInLane(
  state: AppState,
  reader: AccountSwitchAgent,
  scope: AgentSwitchScope
): Generator<LocalAgentPane> {
  const isLaneInScope = getCodexAccountSwitchLaneMatcher(scope)
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
        if (entry?.agentType !== reader.agent || entry.structuredHostOwned) {
          continue
        }
        if (!isLaneInScope(resolveCodexPaneSelectionLane({ state, tab, ptyId }).laneKey)) {
          continue
        }
        const accountId = reader.transcriptAccountId(
          state,
          normalizeAgentProviderSession(entry.providerSession)?.transcriptPath
        )
        yield { worktreeId, tab, leafId, ptyId, accountId }
      }
    }
  }
}

/** Queued restarts in the switch's lane whose session already runs on `accountId`. */
export function findQueuedAccountRestartsOnAccount(
  reader: AccountSwitchAgent,
  scope: AgentSwitchScope & { accountId: string | null }
): string[] {
  const state = useAppStore.getState()
  const ptyIds: string[] = []
  for (const pane of localAgentPanesInLane(state, reader, scope)) {
    if (
      state.pendingPaneAccountRestarts[pane.ptyId] === reader.agent &&
      pane.accountId === scope.accountId
    ) {
      ptyIds.push(pane.ptyId)
    }
  }
  return ptyIds
}

/**
 * Local panes in the switched lane whose session runs on `fromAccountId` (null is System
 * default), the account the switch left. Why
 * none for remote owners: a relay or SSH machine keeps its own login, and its transcript paths
 * name homes this machine does not know.
 */
export async function findMovableAgentSessions(
  reader: AccountSwitchAgent,
  scope: AgentSwitchScope & { fromAccountId: string | null }
): Promise<AccountSwitchSession[]> {
  if (scope.owner.kind !== 'local') {
    return []
  }
  const panes: LocalAgentPane[] = []
  for (const pane of localAgentPanesInLane(useAppStore.getState(), reader, scope)) {
    // Why undefined never matches: an unknown home cannot be shown to be on the old account.
    const { accountId } = pane
    if (accountId !== scope.fromAccountId) {
      continue
    }
    if (
      reader.requiresResume &&
      !resolveAgentAccountRestartResumeStartup(reader.agent, {
        tabId: pane.tab.id,
        leafId: pane.leafId,
        worktreeId: pane.worktreeId,
        shellOverride: pane.tab.shellOverride
      })
    ) {
      continue
    }
    panes.push(pane)
  }
  const inForeground = await Promise.all(
    panes.map((pane) =>
      inspectRuntimeTerminalProcess(pane.ptyId).then(
        (inspection) => reader.isInForeground(pane, inspection),
        () => false
      )
    )
  )
  return panes
    .filter((_, index) => inForeground[index])
    .map((pane) => ({
      ptyId: pane.ptyId,
      worktreeId: pane.worktreeId,
      tabId: pane.tab.id,
      leafId: pane.leafId
    }))
}
