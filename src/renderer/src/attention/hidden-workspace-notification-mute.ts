import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees, getIndexedRepoMap } from '@/store/worktree-repo-index'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { sidebarHasActiveFilters } from '@/components/sidebar/sidebar-filter-actions'
import { computeVisibleWorktreeIds } from '@/components/sidebar/compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from '@/components/sidebar/visible-worktree-options-from-state'
import { isFolderWorkspaceFromOtherDevice } from '../../../shared/workspace-creator-visibility'

/**
 * Workspaces whose attention must raise nothing — no unread, banner, sound or push — because a
 * Filters-menu switch hides them and "Notify About Hidden Workspaces" is off. Worktrees by bare
 * id, folders by `folder:<id>`.
 *
 * Asks the sidebar pipeline itself with the project and host filters lifted, so lineage parents
 * and same-id rows on other hosts notify exactly when the sidebar would show them.
 * Hide sleeping is lifted too: an alerting workspace is awake, so it could only silence alerts
 * whose activity this renderer cannot see (a chat with no tab, a just-exited agent).
 * Fails open: unhydrated settings or UI state, or a workspace this store has no record of, notify.
 */
export function getNotificationHiddenWorkspaceIds(state: AppState): Set<string> {
  const hidden = new Set<string>()
  if (state.settings?.notifications?.notifyHiddenWorkspaces !== false || !state.persistedUIReady) {
    return hidden
  }
  const sleepFree = { ...state, showSleepingWorkspaces: true }
  if (!sidebarHasActiveFilters(sleepFree)) {
    return hidden
  }
  const repoMap = getIndexedRepoMap(state.repos)
  const inputs = buildVisibleWorktreeOptionsFromState(sleepFree, repoMap)
  if (inputs.hideWorkspacesFromOtherDevices) {
    for (const folder of state.folderWorkspaces) {
      if (isFolderWorkspaceFromOtherDevice(folder, inputs.pairedDeviceIdsByEnvironment)) {
        hidden.add(folderWorkspaceKey(folder.id))
      }
    }
  }
  // Why the full sidebar pass: measured at ~0.2-0.3 ms with 1,000 workspaces, and a per-row
  // shortcut would have to mirror every way the sidebar adds rows back.
  const visibleIds = new Set(
    computeVisibleWorktreeIds(state.worktreesByRepo, [], {
      ...inputs,
      filterRepoIds: [],
      workspaceHostScope: ALL_EXECUTION_HOSTS_SCOPE,
      visibleWorkspaceHostIds: null
    })
  )
  for (const worktree of getIndexedAllWorktrees(state.worktreesByRepo)) {
    if (!worktree.isArchived && !visibleIds.has(worktree.id)) {
      hidden.add(worktree.id)
    }
  }
  return hidden
}

export function isWorkspaceNotificationMutedBySidebarFilters(
  state: AppState,
  workspaceId: string
): boolean {
  return getNotificationHiddenWorkspaceIds(state).has(workspaceId)
}
