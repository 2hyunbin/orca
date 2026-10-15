import type { PickerOption } from '../components/PickerModal'
import {
  WORKSPACE_GROUP_BY_CHOICES,
  WORKSPACE_SORT_BY_CHOICES,
  type WorkspaceGroupBy,
  type WorkspaceSortBy,
  type WorkspaceViewChoice
} from '../../../src/shared/workspace-view/workspace-view-options'
import { formatActiveFilterLabel } from '../../../src/shared/workspace-view/workspace-row-filters'

/** The desktop's name for the control that opens these options, and for the options themselves. */
export const WORKSPACE_OPTIONS_TITLE = 'Workspace options'

/** The chip's corner badge, capped as on the desktop; null with no active filter. */
export function workspaceOptionsBadgeText(activeFilterCount: number): string | null {
  if (activeFilterCount <= 0) {
    return null
  }
  return activeFilterCount > 9 ? '9+' : String(activeFilterCount)
}

/** The desktop trigger's accessibility label, word for word. */
export function workspaceOptionsAccessibilityLabel(activeFilterCount: number): string {
  return activeFilterCount > 0
    ? `${WORKSPACE_OPTIONS_TITLE} (${formatActiveFilterLabel(activeFilterCount)} active)`
    : WORKSPACE_OPTIONS_TITLE
}

// Why: the host may be headless, so the note can't promise a desktop sidebar.
export const WORKSPACE_VIEW_SHARED_NOTE = 'Synced across your devices'

function toPickerOption<Id extends string>(choice: WorkspaceViewChoice<Id>): PickerOption<Id> {
  return {
    value: choice.id,
    label: choice.label,
    ...(choice.description ? { subtitle: choice.description } : {})
  }
}

/** The desktop's Sort by choices, in its order and words. */
export const WORKSPACE_SORT_OPTIONS: PickerOption<WorkspaceSortBy>[] =
  WORKSPACE_SORT_BY_CHOICES.map(toPickerOption)

/** The desktop's Group by choices, in its order and words. */
export const WORKSPACE_GROUP_OPTIONS: PickerOption<WorkspaceGroupBy>[] =
  WORKSPACE_GROUP_BY_CHOICES.map(toPickerOption)

/** The Group chip's label: the chosen grouping, or "Group" when there is none. */
export function workspaceGroupChipLabel(groupBy: WorkspaceGroupBy): string {
  return groupBy === 'none'
    ? 'Group'
    : (WORKSPACE_GROUP_OPTIONS.find((option) => option.value === groupBy)?.label ?? 'Group')
}
