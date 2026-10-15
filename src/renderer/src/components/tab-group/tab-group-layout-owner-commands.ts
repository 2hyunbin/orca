// A layout-owner build's tab moves and group sizes. A move: main places the tab first, then the
// window shows main's answer. Main's frame usually shows the move before main answers; while this
// window owes main a save the frame waits, so the window then makes the same move itself, with
// main's new group id. Group sizes: already drawn while dragging, main saves them at the drag's end.

import { useAppStore } from '@/store'
import type { TabSplitDirection } from '@/store/slices/tabs'
import { sendLayoutCommandToOwner, type WindowLayoutCommand } from '@/runtime/layout-owner-command'
import { moveGroupLeafBeside } from '../../../../shared/workspace-layout/tab-group-layout-tree'
import { stableJson } from '../../../../shared/workspace-layout/workspace-layout-load-report'
import { isPaneColumnSplitDropNoOp } from '@/store/slices/pane-column-split-drop-no-op'
import { mirrorWebRuntimeTabMove } from '../tab-bar/web-runtime-tab-move-mirror'

/** A tab drop as the window resolved it: within its group, into another, or beside a group. */
export type TabDrop =
  | { kind: 'reorder'; tabId: string; groupId: string; tabOrder: string[] }
  | { kind: 'move'; tabId: string; groupId: string; index?: number }
  | { kind: 'split'; tabId: string; groupId: string; direction: TabSplitDirection }

/**
 * Sends a tab drop to main; `settle(moved)` runs once the window shows the outcome. False when a
 * paired server owns the workspace's layout; the caller then moves the tab as today.
 */
export function dropTabThroughLayoutOwner(
  worktreeId: string,
  drop: TabDrop,
  settle: (moved: boolean) => void
): boolean {
  const command = commandFor(worktreeId, drop)
  if (!command) {
    return false
  }
  return sendLayoutCommandToOwner(worktreeId, command, {
    apply: ({ groupId }) => settle(showMainMove(worktreeId, drop, groupId)),
    asToday: () => settle(moveAsToday(worktreeId, drop)),
    refused: () => settle(false)
  })
}

function commandFor(worktreeId: string, drop: TabDrop): WindowLayoutCommand | null {
  const { tabId, groupId } = drop
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  if (drop.kind === 'split') {
    const source = groups.find((candidate) => candidate.tabOrder.includes(tabId))
    // Why: a drop the window's own move skips changes nothing; main would still reset the ratio.
    if (
      !source ||
      isPaneColumnSplitDropNoOp({
        sourceGroupId: source.id,
        targetGroupId: groupId,
        splitDirection: drop.direction,
        sourceTabCount: source.tabOrder.length,
        layout: state.layoutByWorktree[worktreeId]
      })
    ) {
      return null
    }
    return { type: 'splitGroup', tabId, besideGroupId: groupId, direction: drop.direction }
  }
  const group = groups.find((candidate) => candidate.id === groupId)
  if (!group) {
    return null
  }
  const index =
    drop.kind === 'reorder'
      ? drop.tabOrder.indexOf(tabId)
      : Math.min(drop.index ?? group.tabOrder.length, group.tabOrder.length)
  return { type: 'moveTab', tabId, toGroupId: groupId, index }
}

/** Today's move, mirrored to a web client's server as today. */
function moveAsToday(worktreeId: string, drop: TabDrop, newGroupId?: string): boolean {
  const state = useAppStore.getState()
  const { tabId, groupId: targetGroupId } = drop
  if (drop.kind === 'reorder') {
    state.reorderUnifiedTabs(targetGroupId, drop.tabOrder)
    mirrorWebRuntimeTabMove({
      kind: 'reorder',
      worktreeId,
      tabId,
      targetGroupId,
      tabOrder: drop.tabOrder
    })
    return true
  }
  if (drop.kind === 'split') {
    const splitDirection = drop.direction
    const moved = state.dropUnifiedTab(tabId, {
      groupId: targetGroupId,
      splitDirection,
      newGroupId
    })
    if (moved) {
      mirrorWebRuntimeTabMove({ kind: 'split', worktreeId, tabId, targetGroupId, splitDirection })
    }
    return moved
  }
  const { index } = drop
  const moved = state.dropUnifiedTab(tabId, {
    groupId: targetGroupId,
    ...(index === undefined ? {} : { index })
  })
  if (moved) {
    mirrorWebRuntimeTabMove({ kind: 'move-to-group', worktreeId, tabId, targetGroupId, index })
  }
  return moved
}

/** Shows main's placement, as main's frame already did or by making it here, and selects the tab. */
function showMainMove(worktreeId: string, drop: TabDrop, mainGroupId: string | undefined): boolean {
  const state = useAppStore.getState()
  const { tabId } = drop
  if (drop.kind === 'reorder') {
    const order = state.groupsByWorktree[worktreeId]?.find((g) => g.id === drop.groupId)?.tabOrder
    if (order?.indexOf(tabId) !== drop.tabOrder.indexOf(tabId)) {
      moveAsToday(worktreeId, drop)
    }
    return true
  }
  const groupId = drop.kind === 'split' ? mainGroupId : drop.groupId
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
  if (!tab || !groupId) {
    return false
  }
  if (tab.groupId !== groupId) {
    return moveAsToday(worktreeId, drop, groupId)
  }
  if (drop.kind === 'split') {
    // Main moved the tab's lone group whole, keeping its id; a no-op once main's frame showed it.
    placeGroupBeside(worktreeId, groupId, drop.groupId, drop.direction)
  }
  state.activateTab(tabId, { worktreeId, preservePreview: true, recordFocus: false })
  useAppStore.getState().focusGroup(worktreeId, groupId)
  return true
}

function placeGroupBeside(
  worktreeId: string,
  groupId: string,
  besideGroupId: string,
  side: TabSplitDirection
): void {
  useAppStore.setState((state) => {
    const layout = state.layoutByWorktree[worktreeId]
    const placed = moveGroupLeafBeside(
      layout ?? { type: 'leaf', groupId: besideGroupId },
      groupId,
      besideGroupId,
      side
    )
    return stableJson(placed) === stableJson(layout)
      ? state
      : { layoutByWorktree: { ...state.layoutByWorktree, [worktreeId]: placed } }
  })
}

/** Sets a group divider's ratio here, as today, then has main save the workspace's group sizes. */
export function setGroupRatioThroughLayoutOwner(
  worktreeId: string,
  nodePath: string,
  ratio: number
): void {
  const state = useAppStore.getState()
  state.setTabGroupSplitRatio(worktreeId, nodePath, ratio)
  const groupLayout = useAppStore.getState().layoutByWorktree[worktreeId]
  if (groupLayout && groupLayout !== state.layoutByWorktree[worktreeId]) {
    // Why keep on every answer: the window's own save still writes these sizes in this phase.
    const keep = (): void => {}
    sendLayoutCommandToOwner(
      worktreeId,
      { type: 'setGroupRatios', groupLayout },
      { apply: keep, asToday: keep }
    )
  }
}
