import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import { resolveLocalTabIdForHostSessionTab } from './web-session-tabs-sync/tracking-mappings'
import {
  getRecentlyClosedTabPositionByTabId,
  insertTabAtRecentlyClosedPosition
} from '../store/slices/recently-closed-tab-position'

export type HostSessionTabClosePlacementState = Pick<
  WebSessionTabsSyncState,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'tabBarOrderByWorktree'
>

export type HostSessionTabClosePlacement = {
  localTabId: string
  groupId: string
  previousTabId?: string
  nextTabId?: string
  previousBarId?: string
  nextBarId?: string
}

export function captureHostSessionTabClosePlacement(
  state: HostSessionTabClosePlacementState,
  environmentId: string,
  worktreeId: string,
  hostTabId: string
): HostSessionTabClosePlacement | undefined {
  const localTabId = resolveLocalTabIdForHostSessionTab({ environmentId, worktreeId, hostTabId })
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === localTabId
  )
  if (!tab) {
    return undefined
  }
  const position = getRecentlyClosedTabPositionByTabId(state, worktreeId, tab.id)
  const group = state.groupsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === position?.groupId
  )
  if (!group || position?.groupIndex === undefined) {
    return undefined
  }
  const bar = state.tabBarOrderByWorktree[worktreeId] ?? []
  const barIndex = bar.indexOf(tab.id)
  return {
    localTabId: tab.id,
    groupId: group.id,
    previousTabId: group.tabOrder[position.groupIndex - 1],
    nextTabId: group.tabOrder[position.groupIndex + 1],
    previousBarId: barIndex !== -1 ? bar[barIndex - 1] : undefined,
    nextBarId: barIndex !== -1 ? bar[barIndex + 1] : undefined
  }
}

function anchoredIndex(
  order: readonly string[],
  previous?: string,
  next?: string
): number | undefined {
  const nextIndex = next === undefined ? -1 : order.indexOf(next)
  if (nextIndex !== -1) {
    return nextIndex
  }
  const previousIndex = previous === undefined ? -1 : order.indexOf(previous)
  return previousIndex !== -1 ? previousIndex + 1 : undefined
}

export function survivingHostSessionTabClosePlacement(
  state: HostSessionTabClosePlacementState,
  worktreeId: string,
  placement: HostSessionTabClosePlacement | undefined
): HostSessionTabClosePlacement | undefined {
  if (!placement) {
    return undefined
  }
  const group = state.groupsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === placement.groupId
  )
  return group &&
    anchoredIndex(group.tabOrder, placement.previousTabId, placement.nextTabId) !== undefined
    ? placement
    : undefined
}

export function insertTabAtHostSessionTabClosePosition(
  order: readonly string[],
  tabId: string,
  previousTabId?: string,
  nextTabId?: string
): string[] {
  const withoutTab = order.filter((id) => id !== tabId)
  const index = anchoredIndex(withoutTab, previousTabId, nextTabId)
  return insertTabAtRecentlyClosedPosition(withoutTab, tabId, { tabBarIndex: index })
}
