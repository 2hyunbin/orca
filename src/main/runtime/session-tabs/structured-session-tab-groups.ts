import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionSnapshotTab
} from '../../../shared/runtime-types'

export function mergeStructuredAgentSessionTabGroups(
  groups: readonly RuntimeMobileSessionTabGroup[],
  existingGroups: readonly RuntimeMobileSessionTabGroup[],
  preservedTabs: readonly RuntimeMobileSessionSnapshotTab[],
  activeTabId: string | null
): RuntimeMobileSessionTabGroup[] {
  const structuredTabs = preservedTabs.filter((tab) => tab.type === 'agent-session')
  if (structuredTabs.length === 0) {
    return [...groups]
  }
  const next = groups.map((group) => ({ ...group, tabOrder: [...group.tabOrder] }))
  for (const tab of structuredTabs) {
    const priorGroupId = existingGroups.find((group) => group.tabOrder.includes(tab.id))?.id
    const target = next.find((group) => group.id === priorGroupId) ?? next[0]
    if (target && !target.tabOrder.includes(tab.id)) {
      target.tabOrder.push(tab.id)
    }
    if (target && tab.id === activeTabId) {
      target.activeTabId = tab.id
    }
  }
  return next
}
