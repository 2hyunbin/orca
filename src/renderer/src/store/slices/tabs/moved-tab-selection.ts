// The user's move selects the moved tab in the store update whose frame shows the move (L120),
// not on main's later reply, which a newer drag may have overtaken.

import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import type { AppState } from '../../types'
import {
  dropMovedTabSelection,
  pendingMovedTabSelections
} from '@/runtime/layout-owner-pane-intents'
import { pushRecentTabId, sanitizeRecentTabIds } from '../tab-group-state'
import { buildActiveSurfacePatch } from './tabs-surface'

type SelectionState = Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree'>

/** The workspace's selection: its active group and each group's active tab. */
export function tabSelectionKey(state: SelectionState, worktreeId: string): string {
  const groups = (state.groupsByWorktree[worktreeId] ?? []).map(
    (group) => `${group.id}:${group.activeTabId ?? ''}`
  )
  return `${state.activeGroupIdByWorktree[worktreeId] ?? ''}|${groups.join(',')}`
}

/** `groups` with `tab` its group's active tab, last in the group's recent tabs. */
export function withTabActiveInGroup(groups: readonly TabGroup[], tab: Tab): TabGroup[] {
  return groups.map((group) =>
    group.id === tab.groupId
      ? {
          ...group,
          activeTabId: tab.id,
          // Why: track every activation in the group's MRU so closeUnifiedTab returns to the previous tab; sanitize to prune removed ids.
          recentTabIds: pushRecentTabId(
            sanitizeRecentTabIds(group.recentTabIds, group.tabOrder),
            tab.id
          )
        }
      : group
  )
}

/** `patch` plus the selection of each moved tab it shows out of its old group. */
export function withMovedTabSelections(before: AppState, patch: Partial<AppState>): Partial<AppState> {
  let next: Partial<AppState> = patch
  for (const intent of pendingMovedTabSelections()) {
    const { worktreeId } = intent
    if (intent.selection === null) {
      continue
    }
    if (tabSelectionKey(before, worktreeId) !== intent.selection) {
      // The user selected or dragged again since the move.
      dropMovedTabSelection(intent)
      continue
    }
    const state: AppState = { ...before, ...next }
    const tab = state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === intent.tabId)
    if (!tab || tab.groupId === intent.fromGroupId) {
      continue
    }
    dropMovedTabSelection(intent)
    const selected = {
      groupsByWorktree: {
        ...state.groupsByWorktree,
        [worktreeId]: withTabActiveInGroup(state.groupsByWorktree[worktreeId] ?? [], tab)
      },
      activeGroupIdByWorktree: { ...state.activeGroupIdByWorktree, [worktreeId]: tab.groupId }
    }
    next = {
      ...next,
      ...selected,
      // As focusing a group does: only the active workspace's surface follows.
      ...(state.activeWorktreeId === worktreeId
        ? buildActiveSurfacePatch({ ...state, ...selected }, worktreeId, tab.groupId)
        : {})
    }
  }
  return next
}
