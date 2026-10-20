// Editor tab closes in a layout-owner build: main closes the tab and its frame drops it; the window
// changes no tab first, so a close main refuses leaves the tab. Once the frame is in, the group
// shows the tab today's close picks (its previous one). Waiters on the tab learn the outcome.

import type { Tab } from '../../../../../../shared/tab-types'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import { beginPendingTab } from '@/runtime/layout-owner-pending-tabs'
import { ownsGlobalSelection } from '../../../global-selection-owner'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { pushRecentTabId, sanitizeRecentTabIds } from '../../tab-group-state'
import type { TabsSliceSet } from '../../tabs/tabs-slice-contract'
import { buildActiveSurfacePatch } from '../../tabs/tabs-surface'
import { isEditorTabContentType } from './editor-tab-content-type'

/** The group's next tab once main's frame dropped the closed one; nothing while it still shows. */
function selectionAfterClose(
  current: AppState,
  tab: Pick<Tab, 'id' | 'worktreeId' | 'groupId'>,
  nextActiveTabId: string | null
): Partial<AppState> | AppState {
  const worktreeId = tab.worktreeId
  if ((current.unifiedTabsByWorktree[worktreeId] ?? []).some((entry) => entry.id === tab.id)) {
    return current
  }
  const groups = current.groupsByWorktree[worktreeId] ?? []
  const group = groups.find((entry) => entry.id === tab.groupId)
  if (!group || !nextActiveTabId || !group.tabOrder.includes(nextActiveTabId)) {
    return current
  }
  const groupsByWorktree = {
    ...current.groupsByWorktree,
    [worktreeId]: groups.map((entry) =>
      entry.id === group.id
        ? {
            ...entry,
            activeTabId: nextActiveTabId,
            recentTabIds: pushRecentTabId(
              sanitizeRecentTabIds(entry.recentTabIds, entry.tabOrder),
              nextActiveTabId
            )
          }
        : entry
    )
  }
  return {
    groupsByWorktree,
    ...(ownsGlobalSelection(current, worktreeId)
      ? buildActiveSurfacePatch(
          { ...current, groupsByWorktree },
          worktreeId,
          current.activeGroupIdByWorktree[worktreeId] ?? null
        )
      : {})
  }
}

/**
 * Sends an editor tab's close; false when it is no editor tab or main is not asked (a paired
 * server owns the workspace's layout), and the caller closes it as today. `closeHere` is today's
 * close, for a twin main may route to a paired server.
 */
export function closeEditorTabThroughLayoutOwner(
  state: AppState,
  set: TabsSliceSet,
  tab: Pick<Tab, 'id' | 'entityId' | 'worktreeId' | 'groupId' | 'contentType'>,
  /** The tab today's close would show next in the group, picked before the close. */
  nextActiveTabId: string | null,
  closeHere: () => void
): boolean {
  if (!isEditorTabContentType(tab.contentType)) {
    return false
  }
  const settle = beginPendingTab(tab.id, tab.worktreeId, tab.entityId)
  const sent = sendLayoutApply(
    state,
    tab.worktreeId,
    { type: 'closeTabs', tabIds: [tab.id] },
    {
      apply: (result) => {
        const closed = result.closed?.includes(tab.id) ?? true
        if (closed) {
          set((current) => selectionAfterClose(current, tab, nextActiveTabId))
        }
        settle(closed ? tab.id : null)
      },
      asToday: () => {
        closeHere()
        settle(tab.id)
      },
      refused: () => settle(null)
    }
  )
  if (!sent) {
    settle(null)
  }
  return sent
}

/** Editor tabs of a workspace whose file record the window just dropped: main closes them. */
export function closeDroppedEditorFileTabsThroughLayoutOwner(
  state: AppState,
  filesBefore: readonly Pick<OpenFile, 'id' | 'worktreeId'>[],
  worktreeId: string
): void {
  const kept = new Set(state.openFiles.map((file) => file.id))
  const dropped = new Set(
    filesBefore.flatMap((file) =>
      file.worktreeId === worktreeId && !kept.has(file.id) ? [file.id] : []
    )
  )
  const keep = (): void => {}
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    if (dropped.has(tab.entityId) && isEditorTabContentType(tab.contentType)) {
      sendLayoutApply(
        state,
        worktreeId,
        { type: 'closeTabs', tabIds: [tab.id] },
        { apply: keep, asToday: keep }
      )
    }
  }
}
