import { useAppStore } from '../../store'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  resolveTerminalTabActivityStatus,
  type TerminalTabActivityStatus
} from './terminal-tab-activity-status'

type TerminalTabActivity = {
  activityStatus: TerminalTabActivityStatus
}

/** A terminal tab's status glyph, as a primitive so unrelated agent updates can't repaint it. */
export function useTerminalTabActivity(
  tab: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>
): TerminalTabActivity {
  // Pane bucketing is memoized per snapshot, so every mounted tab shares one pass.
  const activityStatus = useAppStore((s) =>
    resolveTerminalTabActivityStatus({
      tab,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      agentStatusEpoch: s.agentStatusEpoch,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      terminalLayout: s.terminalLayoutsByTabId?.[tab.id]
    })
  )
  return { activityStatus }
}
