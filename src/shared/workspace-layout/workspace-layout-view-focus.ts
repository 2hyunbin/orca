// A `focusTab`/`focusPane` navigation applied to a view record: the tab becomes its group's shown
// tab, its group the workspace's active group, and the pane its tab's focused pane.

import { paneKeyOf, type WorkspaceLayout } from './workspace-layout-model'
import type { LayoutNavigateRequest } from './workspace-layout-stream-frames'
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
  const paneShown =
    tab.kind !== 'terminal' ||
    !target.leafId ||
    record.panes[tab.entityId]?.activeLeafId === target.leafId
  // Already what the view shows: the same record, so nothing republishes.
  if (
    record.activeGroupIdByWorktree?.[workspaceKey] === group.id &&
    shown?.activeTabId === target.tabId &&
    shown.recentTabIds?.at(-1) === target.tabId &&
    paneShown
  ) {
    return record
  }
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

/** The `navigate` frame that takes a view to a tab, or to a pane of a terminal tab. */
export function navigateRequestFor(
  workspaceKey: string,
  workspace: WorkspaceLayout | undefined,
  target: { tabId: string; leafId?: string }
): LayoutNavigateRequest | null {
  const tab = workspace?.tabs.find((candidate) => candidate.id === target.tabId)
  if (!tab) {
    return null
  }
  return tab.kind === 'terminal' && target.leafId
    ? {
        kind: 'focusPane',
        workspace: workspaceKey,
        paneKey: paneKeyOf(tab.entityId, target.leafId)
      }
    : { kind: 'focusTab', workspace: workspaceKey, tabId: target.tabId }
}
