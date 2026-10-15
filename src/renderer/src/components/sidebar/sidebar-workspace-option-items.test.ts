import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES,
  WORKSPACE_CARD_DISPLAY_CHOICES,
  WORKSPACE_CARD_DISPLAY_FOLDER_BRANCH_LABEL,
  WORKSPACE_CARD_LAYOUT_CHOICES,
  WORKSPACE_CARD_PROPERTY_CHOICES,
  WORKSPACE_GROUP_BY_CHOICES,
  WORKSPACE_PROJECT_ORDER_CHOICES,
  WORKSPACE_SORT_BY_CHOICES
} from '../../../../shared/workspace-view/workspace-view-options'
import {
  AGENT_ACTIVITY_DISPLAY_OPTIONS,
  CARD_LAYOUT_OPTIONS,
  GROUP_BY_OPTIONS,
  PROJECT_ORDER_OPTIONS,
  PROPERTY_OPTIONS,
  SORT_OPTIONS,
  getWorktreeCardDisplayOptions
} from './sidebar-workspace-option-items'

// The desktop's localized copy must read, in English, exactly as the shared copy the phone shows.
const sharedCopy = (choices: readonly { id: string; label: string; description?: string }[]) =>
  choices.map(({ id, label, description }) => ({ id, label, description: description ?? null }))
const desktopCopy = (
  options: readonly { id: string; label: string; description: string | null }[]
) => options.map(({ id, label, description }) => ({ id, label, description }))

describe('desktop Workspace options copy', () => {
  it('matches the shared choices', () => {
    expect(desktopCopy(GROUP_BY_OPTIONS)).toEqual(sharedCopy(WORKSPACE_GROUP_BY_CHOICES))
    expect(desktopCopy(SORT_OPTIONS)).toEqual(sharedCopy(WORKSPACE_SORT_BY_CHOICES))
    expect(desktopCopy(PROJECT_ORDER_OPTIONS)).toEqual(sharedCopy(WORKSPACE_PROJECT_ORDER_CHOICES))
    expect(desktopCopy(CARD_LAYOUT_OPTIONS)).toEqual(sharedCopy(WORKSPACE_CARD_LAYOUT_CHOICES))
    expect(desktopCopy(AGENT_ACTIVITY_DISPLAY_OPTIONS)).toEqual(
      sharedCopy(WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES)
    )
    expect(desktopCopy(PROPERTY_OPTIONS)).toEqual(sharedCopy(WORKSPACE_CARD_PROPERTY_CHOICES))
  })

  it('matches the shared card display choices, with the folder copy only for project groups', () => {
    const copy = (hasProjectGroups: boolean) =>
      getWorktreeCardDisplayOptions(hasProjectGroups).map(({ id, label, properties }) => ({
        id,
        label,
        properties
      }))
    expect(copy(false)).toEqual(
      WORKSPACE_CARD_DISPLAY_CHOICES.map(({ id, label, properties }) => ({ id, label, properties }))
    )
    expect(copy(true).find((option) => option.id === 'branch')?.label).toBe(
      WORKSPACE_CARD_DISPLAY_FOLDER_BRANCH_LABEL
    )
  })
})
