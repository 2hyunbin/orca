// Layout-owner builds: what the one writer of session.tabs rows takes from main's layout for a
// workspace main owns. Only the tab order and the groups: which rows exist, and every fact a row
// carries (its terminal id above all), stay as written, since a writer may know a terminal or an
// exit main's layout has not caught up with.

import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import { orderIdOf, withWindowOnlyIds, type MainSessionTabRows } from './main-session-tab-rows'

/** The written rows, ordered and grouped as main's layout has them. */
export function withMainTabOrder(
  written: RuntimeMobileSessionTabsSnapshot,
  projected: MainSessionTabRows
): RuntimeMobileSessionTabsSnapshot {
  const mainGroups = projected.tabGroups ?? []
  if (mainGroups.length === 0 || written.tabs.length === 0) {
    return written
  }
  const writtenOrder = [...new Set(written.tabs.map(orderIdOf))]
  const writtenIds = new Set(writtenOrder)
  const mainPlaced = new Set(mainGroups.flatMap((group) => group.tabOrder))
  const writtenOnly = new Set(writtenOrder.filter((id) => !mainPlaced.has(id)))
  const writtenGroups = new Map((written.tabGroups ?? []).map((group) => [group.id, group]))
  const groups: RuntimeMobileSessionTabGroup[] = mainGroups.map((group) => {
    const own = writtenGroups.get(group.id)
    const tabOrder = withWindowOnlyIds(
      group.tabOrder.filter((id) => writtenIds.has(id)),
      own?.tabOrder ?? [],
      writtenOnly
    )
    // The written view's selection in the group stands while the group still lists it.
    const activeTabId =
      [own?.activeTabId, group.activeTabId].find((id) => !!id && tabOrder.includes(id)) ??
      tabOrder[0] ??
      null
    return { ...group, tabOrder, activeTabId }
  })
  const activeRow = written.tabs.find((row) => row.id === written.activeTabId)
  const indexOf = (groupId: string | null): number =>
    groups.findIndex((group) => group.id === groupId)
  const activeIndex = (): number => {
    const byRow = activeRow
      ? groups.findIndex((group) => group.tabOrder.includes(orderIdOf(activeRow)))
      : -1
    if (byRow !== -1) {
      return byRow
    }
    const byWritten = indexOf(written.activeGroupId)
    return byWritten !== -1 ? byWritten : Math.max(indexOf(projected.activeGroupId), 0)
  }
  // A written row in a group main does not hold joins the active group: groups are main's.
  const placed = new Set(groups.flatMap((group) => group.tabOrder))
  const stray = writtenOrder.filter((id) => !placed.has(id))
  const strayInto = activeIndex()
  const strayGroup = groups[strayInto]
  if (stray.length > 0 && strayGroup) {
    groups[strayInto] = { ...strayGroup, tabOrder: [...strayGroup.tabOrder, ...stray] }
  }
  const tabGroups = groups.filter((group) => group.tabOrder.length > 0)
  const position = new Map(tabGroups.flatMap((group) => group.tabOrder).map((id, at) => [id, at]))
  const tabs = written.tabs
    .map((row, at) => ({ row, at }))
    .toSorted(
      (a, b) =>
        (position.get(orderIdOf(a.row)) ?? position.size) -
          (position.get(orderIdOf(b.row)) ?? position.size) || a.at - b.at
    )
    .map(({ row }) => row)
  const activeGroupId = groups[activeIndex()]?.id ?? null
  const { tabGroupLayout: _writtenLayout, ...rest } = written
  return {
    ...rest,
    activeGroupId: tabGroups.some((group) => group.id === activeGroupId)
      ? activeGroupId
      : (tabGroups[0]?.id ?? written.activeGroupId),
    tabGroups,
    ...(projected.tabGroupLayout ? { tabGroupLayout: projected.tabGroupLayout } : {}),
    tabs
  }
}
