// The user's move selects the moved tab in the store update whose frame shows the move (L120),
// not on main's later reply, which a newer drag may have overtaken.

import type { AppState } from '../../types'
import {
  dropMovedTabSelection,
  pendingMovedTabSelections
} from '@/runtime/layout-owner-pane-intents'
import { tabActivationPatch } from './tabs-focus-actions'
import { buildActiveSurfacePatch } from './tabs-surface'

type SelectionState = Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree'>

/** The workspace's selection: its active group and each group's active tab. */
export function tabSelectionKey(state: SelectionState, worktreeId: string): string {
  const groups = (state.groupsByWorktree[worktreeId] ?? []).map(
    (group) => `${group.id}:${group.activeTabId ?? ''}`
  )
  return `${state.activeGroupIdByWorktree[worktreeId] ?? ''}|${groups.join(',')}`
}

/** `patch` plus the selection of each moved tab it shows out of its old group. */
export function withMovedTabSelections(
  before: AppState,
  patch: Partial<AppState>
): Partial<AppState> {
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
    // As the window's own move selects it: the preview kept, no focus time recorded.
    const selected = tabActivationPatch(state, tab, worktreeId, {
      preservePreview: true,
      recordFocus: false
    })
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

/** Writes a frame's patch, with the selection of each moved tab it shows. */
export function showFramePatch(
  store: { getState: () => AppState; setState: (patch: Partial<AppState>) => void },
  patch: Partial<AppState>
): void {
  if (Object.keys(patch).length > 0) {
    store.setState(withMovedTabSelections(store.getState(), patch))
  }
}
