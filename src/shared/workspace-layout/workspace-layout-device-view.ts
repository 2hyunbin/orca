// A paired device's view record kept in today's per-device selection store
// (`mobileClientTabSelectionsByDeviceId`): per workspace, its active group and each group's shown
// tab. Fields a phone does not report yet are not stored.

import type { PersistedMobileClientTabSelection } from '../persisted-state-types'
import { emptyLayoutViewRecord, type LayoutViewRecord } from './workspace-layout-views'

type DeviceSelections = Record<string, PersistedMobileClientTabSelection>

export function deviceViewFromSelections(selections: DeviceSelections): LayoutViewRecord {
  const record = emptyLayoutViewRecord()
  const activeGroupIdByWorktree: Record<string, string> = {}
  for (const [key, selection] of Object.entries(selections)) {
    record.groups[key] = Object.fromEntries(
      Object.entries(selection.activeTabIdByGroupId).map(([groupId, activeTabId]) => [
        groupId,
        { activeTabId }
      ])
    )
    if (selection.activeGroupId) {
      activeGroupIdByWorktree[key] = selection.activeGroupId
    }
  }
  return { ...record, activeGroupIdByWorktree }
}

export function deviceSelectionsFromView(record: LayoutViewRecord): DeviceSelections {
  const selections: DeviceSelections = {}
  for (const [key, groups] of Object.entries(record.groups)) {
    const activeGroupId = record.activeGroupIdByWorktree?.[key] ?? null
    const activeTabIdByGroupId: Record<string, string> = {}
    for (const [groupId, { activeTabId }] of Object.entries(groups)) {
      if (activeTabId) {
        activeTabIdByGroupId[groupId] = activeTabId
      }
    }
    selections[key] = {
      activeTabId: (activeGroupId && activeTabIdByGroupId[activeGroupId]) || null,
      activeGroupId,
      activeTabIdByGroupId
    }
  }
  return selections
}
