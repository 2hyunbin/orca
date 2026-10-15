// Bi-directional mapping between the mobile workspaces screen's local view model
// and the desktop's shared PersistedUIState (read/written via the ui.get/ui.set
// RPCs). Keeping these settings in the same global store is what lets a grouping
// or filter change on the phone show up on desktop and vice-versa.

import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import { coerceMobileWorkspaceStatuses } from './mobile-workspace-statuses'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import type { FilterState } from './workspace-list-types'

export type MobileGroupMode = 'none' | 'workspaceStatus' | 'repo' | 'prStatus'
// Desktop sort adds 'manual'; mobile orders it by the desktop's drag ranks.
export type MobileSortMode = 'smart' | 'name' | 'recent' | 'repo' | 'manual'

// Desktop PersistedUIState fields this screen syncs (a structural subset).
export type WorkspaceViewSettings = Partial<Omit<FilterState, 'filterRepoIds'>> & {
  filterRepoIds?: string[]
  groupBy?: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  sortBy?: 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  collapsedGroups?: string[]
  workspaceStatuses?: WorkspaceStatusDefinition[]
  /** Read-only here: the desktop's shown hosts. */
  visibleWorkspaceHostIds?: string[] | null
}

const GROUP_TO_DESKTOP: Record<MobileGroupMode, NonNullable<WorkspaceViewSettings['groupBy']>> = {
  none: 'none',
  workspaceStatus: 'workspace-status',
  repo: 'repo',
  prStatus: 'pr-status'
}

const GROUP_FROM_DESKTOP: Record<NonNullable<WorkspaceViewSettings['groupBy']>, MobileGroupMode> = {
  none: 'none',
  'workspace-status': 'workspaceStatus',
  repo: 'repo',
  'pr-status': 'prStatus'
}

const SORT_VALUES: readonly MobileSortMode[] = ['smart', 'name', 'recent', 'repo', 'manual']

export function groupModeToDesktop(
  mode: MobileGroupMode
): NonNullable<WorkspaceViewSettings['groupBy']> {
  return GROUP_TO_DESKTOP[mode]
}

export function groupModeFromDesktop(
  groupBy: WorkspaceViewSettings['groupBy']
): MobileGroupMode | null {
  return groupBy ? (GROUP_FROM_DESKTOP[groupBy] ?? null) : null
}

export function sortModeFromDesktop(
  sortBy: WorkspaceViewSettings['sortBy']
): MobileSortMode | null {
  return sortBy && SORT_VALUES.includes(sortBy) ? sortBy : null
}

const FILTER_KEYS = [
  'hideSleepingWorkspaces',
  'alwaysShowDefaultBranchWorkspace',
  'hideDefaultBranchWorkspace',
  'hideAutomationGeneratedWorkspaces',
  'hideCliCreatedWorkspaces',
  'hideDetachedHeadWorkspaces',
  'hideWorkspacesFromOtherDevices',
  'filterRepoIds'
] as const satisfies readonly (keyof FilterState)[]
// A filter added to the shared set without a key here fails to compile.
const FILTER_KEYS_COVER_FILTER_STATE: Record<
  Exclude<keyof FilterState, (typeof FILTER_KEYS)[number]>,
  never
> = {}
void FILTER_KEYS_COVER_FILTER_STATE

/**
 * Map a user edit to the ui.set payload, carrying only the fields the edit touched.
 *
 * Why patch-only (STA-5781): the shared store is edited concurrently by desktop and web clients,
 * and this screen's mirror refreshes only on connect/focus. Echoing the whole snapshot let a stale
 * mirror revert sibling fields another client had just changed; the host merges partial updates
 * field-by-field, so sending only the touched fields is lossless.
 */
export function buildWorkspaceViewSettingsUpdate(
  patch: Partial<MobileViewState>,
  next: MobileViewState,
  previous: MobileViewState
): WorkspaceViewSettings {
  const update: WorkspaceViewSettings = {}
  if ('groupMode' in patch) {
    update.groupBy = groupModeToDesktop(next.groupMode)
  }
  if ('sortMode' in patch) {
    update.sortBy = next.sortMode
  }
  if ('filters' in patch) {
    for (const key of FILTER_KEYS) {
      const value = next.filters[key]
      if (value !== previous.filters[key]) {
        Object.assign(update, { [key]: Array.isArray(value) ? [...value] : value })
      }
    }
  }
  if ('collapsedGroups' in patch) {
    update.collapsedGroups = next.collapsedGroups
  }
  if ('workspaceStatuses' in patch) {
    update.workspaceStatuses = [...next.workspaceStatuses]
  }
  return update
}

export type MobileViewState = {
  groupMode: MobileGroupMode
  sortMode: MobileSortMode
  filters: FilterState
  collapsedGroups: string[]
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}

export const NO_FILTERS: FilterState = {
  hideSleepingWorkspaces: NO_WORKSPACE_ROW_FILTERS.hideSleepingWorkspaces,
  alwaysShowDefaultBranchWorkspace: NO_WORKSPACE_ROW_FILTERS.alwaysShowDefaultBranchWorkspace,
  hideDefaultBranchWorkspace: NO_WORKSPACE_ROW_FILTERS.hideDefaultBranchWorkspace,
  hideAutomationGeneratedWorkspaces: NO_WORKSPACE_ROW_FILTERS.hideAutomationGeneratedWorkspaces,
  hideCliCreatedWorkspaces: NO_WORKSPACE_ROW_FILTERS.hideCliCreatedWorkspaces,
  hideDetachedHeadWorkspaces: NO_WORKSPACE_ROW_FILTERS.hideDetachedHeadWorkspaces,
  hideWorkspacesFromOtherDevices: NO_WORKSPACE_ROW_FILTERS.hideWorkspacesFromOtherDevices,
  filterRepoIds: NO_WORKSPACE_ROW_FILTERS.filterRepoIds
}

// Apply a desktop PersistedUIState onto the local view state, leaving any field
// the desktop hasn't set untouched (so a partial ui.get doesn't clobber).
export function applyDesktopViewSettings(
  current: MobileViewState,
  settings: WorkspaceViewSettings
): MobileViewState {
  const groupMode = groupModeFromDesktop(settings.groupBy)
  const sortMode = sortModeFromDesktop(settings.sortBy)
  // Why: a partially hydrated desktop settings payload may carry an empty
  // status catalog; mobile must keep renderable groups instead of hiding rows.
  const workspaceStatuses = settings.workspaceStatuses
    ? coerceMobileWorkspaceStatuses(settings.workspaceStatuses)
    : current.workspaceStatuses
  const filters: FilterState = { ...current.filters }
  for (const key of FILTER_KEYS) {
    if (settings[key] !== undefined) {
      Object.assign(filters, { [key]: settings[key] })
    }
  }
  return {
    groupMode: groupMode ?? current.groupMode,
    sortMode: sortMode ?? current.sortMode,
    filters,
    collapsedGroups: settings.collapsedGroups ?? current.collapsedGroups,
    workspaceStatuses
  }
}
