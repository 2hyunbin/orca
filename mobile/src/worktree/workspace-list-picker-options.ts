import type { PickerOption } from '../components/PickerModal'
import {
  WORKSPACE_GROUP_BY_CHOICES,
  WORKSPACE_SORT_BY_CHOICES,
  type WorkspaceViewChoice
} from '../../../src/shared/workspace-view/workspace-view-options'
import {
  groupModeFromDesktop,
  type MobileGroupMode,
  type MobileSortMode
} from './workspace-view-settings'

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
export const WORKSPACE_SORT_OPTIONS: PickerOption<MobileSortMode>[] =
  WORKSPACE_SORT_BY_CHOICES.map(toPickerOption)

/** The desktop's Group by choices, keyed by the phone's own group modes. */
export const WORKSPACE_GROUP_OPTIONS: PickerOption<MobileGroupMode>[] =
  WORKSPACE_GROUP_BY_CHOICES.flatMap((choice) => {
    const mode = groupModeFromDesktop(choice.id)
    return mode ? [{ value: mode, label: choice.label }] : []
  })

/** The Group chip's label: the chosen grouping, or "Group" when there is none. */
export function workspaceGroupChipLabel(mode: MobileGroupMode): string {
  return mode === 'none'
    ? 'Group'
    : (WORKSPACE_GROUP_OPTIONS.find((option) => option.value === mode)?.label ?? 'Group')
}
