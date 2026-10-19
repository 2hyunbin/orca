import { useCallback } from 'react'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { toVisibleTabType } from '../../../../shared/tab-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { captureWorkspaceEmptiedReaction } from './workspace-emptied-reaction'
import { track } from '@/lib/telemetry'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'

export function useTabGroupCloseScopeCommands({
  groupId,
  worktreeId,
  group,
  groupTabs,
  closeItem,
  closeMany
}: {
  groupId: string
  worktreeId: string
  group: TabGroup | null
  groupTabs: Tab[]
  closeItem: (itemId: string, opts?: { skipEmptyCheck?: boolean }) => void
  closeMany: (itemIds: string[]) => void
}) {
  const closeEmptyGroup = useAppStore((state) => state.closeEmptyGroup)

  const closeGroup = useCallback(() => {
    const whenEmptied = captureWorkspaceEmptiedReaction(worktreeId)
    const items = [...(useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? [])].filter(
      (item) => item.groupId === groupId
    )
    for (const item of items) {
      closeItem(item.id, { skipEmptyCheck: true })
    }
    // Why: closing tabs doesn't remove the group shell; empty split groups are layout state, collapse the placeholder pane here.
    closeEmptyGroup(worktreeId, groupId)
    whenEmptied()
  }, [closeEmptyGroup, closeItem, groupId, worktreeId])

  const closeAllEditorTabsInGroup = useCallback(() => {
    for (const item of groupTabs) {
      if (isEditorTabContentType(item.contentType)) {
        if (!item.isPinned) {
          closeItem(item.id)
        }
      }
    }
  }, [closeItem, groupTabs])

  const closeOthers = useCallback(
    (itemId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === itemId)
      if (!item) {
        return
      }
      // Why: store closeOtherTabs strands dirty files if the save dialog is cancelled; route via closeMany to stay dirty-aware.
      const siblingIds = groupTabs
        .filter((candidate) => candidate.id !== itemId && !candidate.isPinned)
        .map((candidate) => candidate.id)
      closeMany(siblingIds)
    },
    [closeMany, groupTabs]
  )

  const closeInDirection = useCallback(
    (itemId: string, direction: 'left' | 'right') => {
      // Preserve visible order and save prompts by routing through closeMany.
      const order = group?.tabOrder ?? []
      const index = order.indexOf(itemId)
      if (index === -1) {
        return
      }
      const tabById = new Map(groupTabs.map((candidate) => [candidate.id, candidate]))
      const sideIds = direction === 'left' ? order.slice(0, index) : order.slice(index + 1)
      const eligibleIds = sideIds.filter((id) => {
        const candidate = tabById.get(id)
        return candidate ? !candidate.isPinned : false
      })
      const item = tabById.get(itemId)
      if (item) {
        track('tabs_directional_close_requested', {
          direction,
          tab_type: toVisibleTabType(item.contentType),
          surface: worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? 'floating' : 'workspace',
          eligible_tab_count: eligibleIds.length
        })
      }
      closeMany(eligibleIds)
    },
    [closeMany, group, groupTabs, worktreeId]
  )

  const closeToRight = useCallback(
    (itemId: string) => closeInDirection(itemId, 'right'),
    [closeInDirection]
  )
  const closeToLeft = useCallback(
    (itemId: string) => closeInDirection(itemId, 'left'),
    [closeInDirection]
  )

  return { closeGroup, closeAllEditorTabsInGroup, closeOthers, closeToRight, closeToLeft }
}
