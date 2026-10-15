import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees, getIndexedRepoMap } from '@/store/worktree-repo-index'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { sidebarHasActiveFilters } from '@/components/sidebar/sidebar-filter-actions'
import { computeVisibleWorktreeIds } from '@/components/sidebar/compute-visible-worktrees'
import { isHiddenBySidebarSwitch } from '@/components/sidebar/sidebar-switch-hidden-workspace'
import { buildVisibleWorktreeOptionsFromState } from '@/components/sidebar/visible-worktree-options-from-state'
import { isFolderWorkspaceFromOtherDevice } from '../../../shared/workspace-creator-visibility'

/**
 * Whether attention from this workspace must raise nothing — no unread, banner, sound or push —
 * because a Filters-menu switch hides it and "Notify About Hidden Workspaces" is off.
 *
 * Asks the sidebar pipeline itself with the project and host filters lifted, so lineage parents
 * and same-id rows on other hosts notify exactly when the sidebar would show them.
 * Fails open: unhydrated settings or UI state, terminals not yet reconnected (every restored
 * workspace would read as sleeping), or a workspace this store has no record of, notify.
 */
export function isWorkspaceNotificationMutedBySidebarFilters(
  state: AppState,
  workspaceId: string
): boolean {
  if (
    state.settings?.notifications?.notifyHiddenWorkspaces !== false ||
    !state.persistedUIReady ||
    !state.workspaceSessionReady ||
    !sidebarHasActiveFilters(state)
  ) {
    return false
  }
  const repoMap = getIndexedRepoMap(state.repos)
  const inputs = buildVisibleWorktreeOptionsFromState(state, repoMap)
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const folder = state.folderWorkspaces.find((item) => item.id === scope.folderWorkspaceId)
    return (
      folder !== undefined &&
      inputs.hideWorkspacesFromOtherDevices &&
      isFolderWorkspaceFromOtherDevice(folder, inputs.pairedDeviceIdsByEnvironment)
    )
  }
  const matches = getIndexedAllWorktrees(state.worktreesByRepo).filter(
    (worktree) => worktree.id === workspaceId && !worktree.isArchived
  )
  // Why these shortcuts: the full pass below only adds lineage parents, so a row the switches show
  // is visible, and a hidden row no lineage record names as a parent cannot be shown above a child.
  if (
    matches.length === 0 ||
    matches.some(
      (worktree) => !isHiddenBySidebarSwitch(worktree, repoMap.get(worktree.repoId), inputs)
    )
  ) {
    return false
  }
  if (
    !Object.values(state.worktreeLineageById).some(
      (lineage) => lineage.parentWorktreeId === workspaceId
    )
  ) {
    return true
  }
  const visibleIds = computeVisibleWorktreeIds(state.worktreesByRepo, [], {
    ...inputs,
    filterRepoIds: [],
    workspaceHostScope: ALL_EXECUTION_HOSTS_SCOPE,
    visibleWorkspaceHostIds: null
  })
  return !visibleIds.includes(workspaceId)
}
