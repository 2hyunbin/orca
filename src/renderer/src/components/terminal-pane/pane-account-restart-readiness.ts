import type { AppState } from '@/store'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import { isAgentPaneMidTurn } from '@/lib/agent-account-switch-sessions'
import { ACCOUNT_SWITCH_AGENTS } from '@/lib/agent-account-switch-agents'
import { makePaneKey } from '../../../../shared/stable-pane-id'

/** Whether a queued restart for `agent` may run in `paneKey` now, per its agent's idle rule. */
export function isQueuedAccountRestartReady(
  state: AppState,
  agent: AccountRestartAgent,
  paneKey: string
): boolean {
  return !ACCOUNT_SWITCH_AGENTS[agent].waitsForIdle || !isAgentPaneMidTurn(state, paneKey, agent)
}

/** PTYs whose queued account restart can run now: at once, or once the turn ends where it waits. */
export function selectReadyAccountRestartPtyIds(state: AppState, tabId: string): string[] {
  const pending = state.pendingPaneAccountRestarts
  const ready = Object.keys(pending).filter(
    (ptyId) => !ACCOUNT_SWITCH_AGENTS[pending[ptyId]].waitsForIdle
  )
  const ptyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
    const queued = pending[ptyId]
    if (
      queued &&
      ACCOUNT_SWITCH_AGENTS[queued].waitsForIdle &&
      isQueuedAccountRestartReady(state, queued, makePaneKey(tabId, leafId))
    ) {
      ready.push(ptyId)
    }
  }
  return ready
}

/** Whether `ptyId`'s queued restart can run against the store as it is now. */
export function isAccountRestartReady(
  state: AppState,
  tabId: string,
  leafId: string,
  ptyId: string
): boolean {
  const queued = state.pendingPaneAccountRestarts[ptyId]
  return (
    queued !== undefined && isQueuedAccountRestartReady(state, queued, makePaneKey(tabId, leafId))
  )
}
