// Bi-directional mapping between the mobile workspaces screen's local view model
// and the desktop's shared PersistedUIState (read/written via the ui.get/ui.set
// RPCs). Keeping these settings in the same global store is what lets a grouping
// or filter change on the phone show up on desktop and vice-versa.

import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import { coerceMobileWorkspaceStatuses } from './mobile-workspace-statuses'
import { WORKSPACE_ROW_FILTER_KEYS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { normalizeVisibleExecutionHostIds } from '../../../src/shared/execution-host'
import type { PersistedUIState } from '../../../src/shared/persisted-ui-state-types'
import type { FilterState } from './workspace-list-types'

export type MobileGroupMode = 'none' | 'workspaceStatus' | 'repo' | 'prStatus'
export type MobileSortMode = PersistedUIState['sortBy']

type PersistedFilterKey<Key extends keyof FilterState> = Key extends 'visibleHostIds'
  ? 'visibleWorkspaceHostIds'
  : Key

// Desktop PersistedUIState fields this screen syncs (a structural subset).
export type WorkspaceViewSettings = {
  [Key in keyof FilterState as PersistedFilterKey<Key>]?: Key extends 'filterRepoIds'
    ? string[]
    : Key extends 'visibleHostIds'
      ? string[] | null
      : FilterState[Key]
} & {
  groupBy?: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  sortBy?: MobileSortMode
  collapsedGroups?: string[]
  workspaceStatuses?: WorkspaceStatusDefinition[]
}

/** The desktop's name for a filter: only the host scope differs. */
function persistedFilterKey(key: keyof FilterState): keyof WorkspaceViewSettings {
  return key === 'visibleHostIds' ? 'visibleWorkspaceHostIds' : key
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

/**
 * Map a user edit to the ui.set payload, carrying only the fields the edit touched.
 *
 * Why patch-only (STA-5781): the shared store is edited concurrently by desktop and web clients,
 * and this screen's mirror refreshes only on connect/focus. Echoing the whole snapshot let a stale
 * mirror revert sibling fields another client had just changed; the host merges partial updates
 * field-by-field, so sending only the touched fields is lossless.
 */
export function buildWorkspaceViewSettingsUpdate(
  patch: MobileViewPatch,
  next: MobileViewState
): WorkspaceViewSettings {
  const update: WorkspaceViewSettings = {}
  if ('groupMode' in patch) {
    update.groupBy = groupModeToDesktop(next.groupMode)
  }
  if ('sortMode' in patch) {
    update.sortBy = next.sortMode
  }
  for (const key of WORKSPACE_ROW_FILTER_KEYS) {
    if (patch.filters && key in patch.filters) {
      const value = next.filters[key]
      Object.assign(update, {
        [persistedFilterKey(key)]: Array.isArray(value) ? [...value] : value
      })
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

/** An edit: the fields it sets, and for filters only the filters it touches. */
export type MobileViewPatch = Partial<Omit<MobileViewState, 'filters'>> & {
  filters?: Partial<FilterState>
}

export type MobileViewState = {
  groupMode: MobileGroupMode
  sortMode: MobileSortMode
  filters: FilterState
  collapsedGroups: string[]
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
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
  for (const key of WORKSPACE_ROW_FILTER_KEYS) {
    const value = settings[persistedFilterKey(key)]
    if (value !== undefined) {
      Object.assign(filters, { [key]: value })
    }
  }
  if (settings.visibleWorkspaceHostIds !== undefined) {
    filters.visibleHostIds = normalizeVisibleExecutionHostIds(settings.visibleWorkspaceHostIds)
  }
  return {
    groupMode: groupMode ?? current.groupMode,
    sortMode: sortMode ?? current.sortMode,
    filters,
    collapsedGroups: settings.collapsedGroups ?? current.collapsedGroups,
    workspaceStatuses
  }
}
