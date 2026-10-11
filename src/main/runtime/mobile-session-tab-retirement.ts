import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

/**
 * The snapshot with one listed tab removed, or null when it does not list that id.
 *
 * Pure: the caller stores and emits. How a closed chat, browser or editor tab leaves the host's list.
 */
export function retireMobileSessionTabFrom(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  tabId: string
): RuntimeMobileSessionTabsSnapshot | null {
  if (!snapshot.tabs.some((candidate) => candidate.id === tabId)) {
    return null
  }
  const nextTabs = snapshot.tabs.filter((candidate) => candidate.id !== tabId)
  const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
  return {
    ...snapshot,
    snapshotVersion: snapshot.snapshotVersion + 1,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    tabGroups: (snapshot.tabGroups ?? []).map((group) => ({
      ...group,
      tabOrder: group.tabOrder.filter((id) => id !== tabId),
      activeTabId: group.activeTabId === tabId ? null : group.activeTabId,
      recentTabIds: group.recentTabIds?.filter((id) => id !== tabId)
    })),
    tabs: nextTabs
  }
}
