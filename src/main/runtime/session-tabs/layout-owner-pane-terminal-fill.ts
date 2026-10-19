import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'

/**
 * Layout-owner builds: main writes a new pane before it binds the pane's terminal, so the window
 * can list the pane with no terminal after main listed it with one. Main's binding fills the gap.
 */
export function withMainPaneTerminals(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  boundTerminal: (tabId: string, leafId: string) => string | null
): RuntimeMobileSessionTabsSnapshot {
  let filled = false
  const tabs = snapshot.tabs.map((tab) => {
    if (tab.type !== 'terminal' || tab.ptyId) {
      return tab
    }
    const ptyId = boundTerminal(tab.parentTabId, tab.leafId)
    if (!ptyId) {
      return tab
    }
    filled = true
    return { ...tab, ptyId }
  })
  return filled ? { ...snapshot, tabs } : snapshot
}
