import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import { resolveLocalTabIdForHostSessionTab } from './web-session-tabs-sync/tracking-mappings'
import {
  getRecentlyClosedTabPositionByTabId,
  insertTabAtRecentlyClosedPosition
} from '../store/slices/recently-closed-tab-position'

export type HostSessionTabClosePlacement = {
  localTabId: string
  groupId: string
  previousTabId?: string
  nextTabId?: string
  previousBarId?: string
  nextBarId?: string
}

export function captureHostSessionTabClosePlacement(
  state: WebSessionTabsSyncState,
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
  state: WebSessionTabsSyncState,
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

export function applyHostSessionTabClosePlacement(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  placement: HostSessionTabClosePlacement
): Partial<WebSessionTabsSyncState> {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const group = groups.find((candidate) => candidate.id === placement.groupId)
  if (!group?.tabOrder.includes(placement.localTabId)) {
    return {}
  }
  const order = group.tabOrder.filter((id) => id !== placement.localTabId)
  const index = anchoredIndex(order, placement.previousTabId, placement.nextTabId)
  if (index === undefined) {
    return {}
  }
  const tabOrder = insertTabAtRecentlyClosedPosition(order, placement.localTabId, {
    tabBarIndex: index
  })
  const bar = state.tabBarOrderByWorktree[worktreeId] ?? []
  const barOrder = bar.filter((id) => id !== placement.localTabId)
  const barIndex = anchoredIndex(barOrder, placement.previousBarId, placement.nextBarId)
  return {
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [worktreeId]: groups.map((candidate) =>
        candidate === group ? { ...candidate, tabOrder } : candidate
      )
    },
    ...(barIndex !== undefined
      ? {
          tabBarOrderByWorktree: {
            ...state.tabBarOrderByWorktree,
            [worktreeId]: insertTabAtRecentlyClosedPosition(barOrder, placement.localTabId, {
              tabBarIndex: barIndex
            })
          }
        }
      : {})
  }
}
