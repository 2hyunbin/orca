import { structuredLaunchSlotIds } from './structured-agent-session-launch-persistence'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import type { AppState } from '../store'
import { unchosenCreationAgent } from '../store/slices/tabs/desktop-tab-choice'

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
  savesShownTab: boolean
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
      const activeTabId =
        savesShownTab && group.activeTabId && validTabIds.has(group.activeTabId)
          ? group.activeTabId
          : null
      return {
        ...group,
        activeTabId,
        tabOrder,
        recentTabIds: group.recentTabIds?.filter((tabId) => validTabIds.has(tabId))
      }
    })
    .filter((group) => group.tabOrder.length > 0)
}

export function buildPersistedUnifiedTabSessionData(
  snapshot: Pick<
    WorkspaceSessionSnapshot,
    'activeGroupIdByWorktree' | 'groupsByWorktree' | 'layoutByWorktree' | 'unifiedTabsByWorktree'
  > &
    // Read from the live store the payload is built from; every pick also activates its tab,
    // which is what schedules the write.
    Partial<Pick<AppState, 'desktopTabChoices' | 'folderWorkspaces' | 'worktreesByRepo'>>
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
    ...Object.keys(sourceLayouts)
  ])

  for (const worktreeId of worktreeIds) {
    const tabs = sourceTabs[worktreeId] ?? []
    if (tabs.length === 0 && structuredLaunchSlotIds(worktreeId).size === 0) {
      continue
    }

    // Why: a derived default is not this window's choice; saved, it would restore as one and
    // pin an interim Setup over the agent that arrives after a reload.
    const groups = buildPersistedGroupsForWorktree(
      tabs,
      sourceGroups[worktreeId] ?? [],
      worktreeId,
      !unchosenCreationAgent(snapshot, worktreeId)
    )
    if (groups.length === 0) {
      continue
    }

    const groupIds = new Set(groups.map((group) => group.id))
    const persistedTabs = tabs.filter((tab) => groupIds.has(tab.groupId))
    if (persistedTabs.length === 0 && structuredLaunchSlotIds(worktreeId).size === 0) {
      continue
    }

    unifiedTabs[worktreeId] = persistedTabs
    tabGroups[worktreeId] = groups
    const activeGroupId = sourceActiveGroups[worktreeId]
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
