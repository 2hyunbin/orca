import { structuredLaunchSlotIds } from './structured-agent-session-launch-persistence'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'

type PersistedUnifiedTabSessionData = Pick<
  WorkspaceSessionState,
  'activeGroupIdByWorktree' | 'tabGroupLayouts' | 'tabGroups' | 'unifiedTabs'
>

function prunePersistedLayoutForGroups(
  root: TabGroupLayoutNode,
  validGroupIds: Set<string>
): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return validGroupIds.has(root.groupId) ? root : null
  }

  const first = prunePersistedLayoutForGroups(root.first, validGroupIds)
  const second = prunePersistedLayoutForGroups(root.second, validGroupIds)

  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }

  return { ...root, first, second }
}

function buildPersistedGroupsForWorktree(
  tabs: Tab[],
  groups: TabGroup[],
  worktreeId: string,
  choices: Record<string, { activeTabId: string | null }> | undefined
): TabGroup[] {
  const validTabIds = new Set(tabs.map((tab) => tab.id))
  const tabIdsByGroup = new Map<string, string[]>()
  for (const tab of tabs) {
    const groupTabs = tabIdsByGroup.get(tab.groupId) ?? []
    groupTabs.push(tab.id)
    tabIdsByGroup.set(tab.groupId, groupTabs)
  }

  return groups
    .map((group) => {
      const slots = structuredLaunchSlotIds(worktreeId, group.id)
      const orderedTabIds = new Set([
        ...group.tabOrder.filter((tabId) => validTabIds.has(tabId) || slots.has(tabId)),
        ...(tabIdsByGroup.get(group.id) ?? [])
      ])
      const tabOrder = Array.from(orderedTabIds)
      const activeTabId = choices
        ? (choices[group.id]?.activeTabId ?? null)
        : group.activeTabId && validTabIds.has(group.activeTabId)
          ? group.activeTabId
          : null
      return {
        ...group,
        activeTabId,
        tabOrder,
        recentTabIds: group.recentTabIds?.filter((tabId) => validTabIds.has(tabId))
      }
    })
    .filter((group) => group.tabOrder.length > 0 || group.activeTabId !== null)
}

export function buildPersistedUnifiedTabSessionData(
  snapshot: Pick<
    WorkspaceSessionSnapshot,
    | 'activeGroupIdByWorktree'
    | 'groupsByWorktree'
    | 'layoutByWorktree'
    | 'unifiedTabsByWorktree'
    | 'desktopLayoutView'
  >
): PersistedUnifiedTabSessionData {
  const unifiedTabs: WorkspaceSessionState['unifiedTabs'] = {}
  const tabGroups: WorkspaceSessionState['tabGroups'] = {}
  const tabGroupLayouts: WorkspaceSessionState['tabGroupLayouts'] = {}
  const activeGroupIdByWorktree: WorkspaceSessionState['activeGroupIdByWorktree'] = {}
  const sourceTabs = snapshot.unifiedTabsByWorktree ?? {}
  const sourceGroups = snapshot.groupsByWorktree ?? {}
  const sourceLayouts = snapshot.layoutByWorktree ?? {}
  const sourceActiveGroups = snapshot.activeGroupIdByWorktree ?? {}
  const worktreeIds = new Set([
    ...Object.keys(sourceTabs),
    ...Object.keys(sourceGroups),
    ...Object.keys(sourceLayouts),
    ...Object.keys(snapshot.desktopLayoutView?.groups ?? {})
  ])

  for (const worktreeId of worktreeIds) {
    const tabs = sourceTabs[worktreeId] ?? []
    const rawGroups = snapshot.desktopLayoutView?.groups[worktreeId]
    if (
      tabs.length === 0 &&
      !Object.values(rawGroups ?? {}).some((group) => group.activeTabId) &&
      structuredLaunchSlotIds(worktreeId).size === 0
    ) {
      continue
    }

    const groups = buildPersistedGroupsForWorktree(
      tabs,
      [
        ...(sourceGroups[worktreeId] ?? []),
        ...Object.entries(rawGroups ?? {}).flatMap(([id, choice]) =>
          sourceGroups[worktreeId]?.some((group) => group.id === id)
            ? []
            : [{ id, worktreeId, tabOrder: [], ...choice }]
        )
      ],
      worktreeId,
      snapshot.desktopLayoutView?.groups[worktreeId] ??
        (snapshot.desktopLayoutView ? {} : undefined)
    )
    if (groups.length === 0) {
      continue
    }

    const groupIds = new Set(groups.map((group) => group.id))
    const persistedTabs = tabs.filter((tab) => groupIds.has(tab.groupId))
    if (
      persistedTabs.length === 0 &&
      !groups.some((group) => group.activeTabId) &&
      structuredLaunchSlotIds(worktreeId).size === 0
    ) {
      continue
    }

    unifiedTabs[worktreeId] = persistedTabs
    tabGroups[worktreeId] = groups
    const activeGroupId =
      snapshot.desktopLayoutView?.activeGroupIdByWorktree?.[worktreeId] ??
      sourceActiveGroups[worktreeId]
    activeGroupIdByWorktree[worktreeId] =
      activeGroupId && groupIds.has(activeGroupId) ? activeGroupId : groups[0].id
    const prunedLayout = sourceLayouts[worktreeId]
      ? prunePersistedLayoutForGroups(sourceLayouts[worktreeId], groupIds)
      : null
    tabGroupLayouts[worktreeId] = prunedLayout ?? { type: 'leaf', groupId: groups[0].id }
  }

  return {
    unifiedTabs,
    tabGroups,
    tabGroupLayouts,
    activeGroupIdByWorktree
  }
}
