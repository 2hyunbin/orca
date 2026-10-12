// A `focusTab`/`focusPane` navigation applied to a view record: the tab becomes its group's shown
// tab, its group the workspace's active group, and the pane its tab's focused pane.

import type { WorkspaceLayout } from './workspace-layout-model'
import type { LayoutViewRecord } from './workspace-layout-views'

export function focusInViewRecord(
  record: LayoutViewRecord,
  workspaceKey: string,
  workspace: WorkspaceLayout,
  target: { tabId: string; leafId?: string }
): LayoutViewRecord {
  const tab = workspace.tabs.find((candidate) => candidate.id === target.tabId)
  const group = workspace.groups.find((candidate) => candidate.tabOrder.includes(target.tabId))
  if (!tab || !group) {
    return record
  }
  const shown = record.groups[workspaceKey]?.[group.id]
  const recentTabIds = [
    ...(shown?.recentTabIds ?? []).filter((id) => id !== target.tabId),
    target.tabId
  ]
  return {
    ...record,
    activeGroupIdByWorktree: { ...record.activeGroupIdByWorktree, [workspaceKey]: group.id },
    groups: {
      ...record.groups,
      [workspaceKey]: {
        ...record.groups[workspaceKey],
        [group.id]: { activeTabId: target.tabId, recentTabIds }
      }
    },
    ...(tab.kind === 'terminal' && target.leafId
      ? {
          panes: {
            ...record.panes,
            [tab.entityId]: {
              activeLeafId: target.leafId,
              expandedLeafId: record.panes[tab.entityId]?.expandedLeafId ?? null
            }
          }
        }
      : {})
  }
}
