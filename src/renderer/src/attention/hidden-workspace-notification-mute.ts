import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees, getIndexedRepoMap } from '@/store/worktree-repo-index'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { sidebarHasActiveFilters } from '@/components/sidebar/sidebar-filter-actions'
import { computeVisibleWorktreeIds } from '@/components/sidebar/compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from '@/components/sidebar/visible-worktree-options-from-state'
import { isFolderWorkspaceFromOtherDevice } from '../../../shared/workspace-creator-visibility'

const NO_HIDDEN_WORKSPACES: ReadonlySet<string> = new Set()

/** Every state field the hidden set reads; none is time-dependent, so the memo is exact. */
function hiddenSetInputs(state: AppState): readonly unknown[] {
  return [
    state.settings,
    state.persistedUIReady,
    state.worktreesByRepo,
    state.repos,
    state.folderWorkspaces,
    state.worktreeLineageById,
    state.sortBy,
    state.showSleepingWorkspaces,
    state.filterRepoIds,
    state.workspaceHostScope,
    state.visibleWorkspaceHostIds,
    state.hideDefaultBranchWorkspace,
    state.hideAutomationGeneratedWorkspaces,
    state.hideCliCreatedWorkspaces,
    state.hideDetachedHeadWorkspaces,
    state.hideWorkspacesFromOtherDevices,
    state.alwaysShowDefaultBranchWorkspace,
    state.runtimeEnvironments,
    state.runtimeStatusByEnvironmentId
  ]
}

let cached: { inputs: readonly unknown[]; ids: ReadonlySet<string> } | null = null

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
export function getNotificationHiddenWorkspaceIds(state: AppState): ReadonlySet<string> {
  const inputs = hiddenSetInputs(state)
  const previous = cached
  if (previous && inputs.every((input, index) => input === previous.inputs[index])) {
    return previous.ids
  }
  const ids = computeNotificationHiddenWorkspaceIds(state)
  cached = { inputs, ids }
  return ids
}

function computeNotificationHiddenWorkspaceIds(state: AppState): ReadonlySet<string> {
  if (
    state.settings?.notifications?.notifyHiddenWorkspaces !== false ||
    !state.persistedUIReady ||
    !sidebarHasActiveFilters(state)
  ) {
    return NO_HIDDEN_WORKSPACES
  }
  const repoMap = getIndexedRepoMap(state.repos)
  const inputs = buildVisibleWorktreeOptionsFromState(state, repoMap)
  const hidden = new Set<string>()
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
      showSleepingWorkspaces: true,
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
  return hidden.size > 0 ? hidden : NO_HIDDEN_WORKSPACES
}

export function isWorkspaceNotificationMutedBySidebarFilters(
  state: AppState,
  workspaceId: string
): boolean {
  return getNotificationHiddenWorkspaceIds(state).has(workspaceId)
}
