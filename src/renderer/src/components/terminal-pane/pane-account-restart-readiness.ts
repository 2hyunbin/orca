import type { AppState } from '@/store'
import { isAgentPaneMidTurn } from '@/lib/agent-account-switch-sessions'
import { makePaneKey } from '../../../../shared/stable-pane-id'

/** PTYs whose queued account restart can run now: Codex at once, this tab's Claude once its turn ends. */
export function selectReadyAccountRestartPtyIds(state: AppState, tabId: string): string[] {
  const pending = state.pendingPaneAccountRestarts
  const ready = Object.keys(pending).filter((ptyId) => pending[ptyId] === 'codex')
  const ptyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
    if (
      pending[ptyId] === 'claude' &&
      !isAgentPaneMidTurn(state, makePaneKey(tabId, leafId), 'claude')
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
    queued === 'codex' ||
    (queued === 'claude' && !isAgentPaneMidTurn(state, makePaneKey(tabId, leafId), 'claude'))
  )
}
