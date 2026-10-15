import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_CARD_DISPLAY_CHOICES,
  WORKSPACE_CARD_PROPERTY_CHOICES
} from '../../../src/shared/workspace-view/workspace-view-options'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../src/shared/worktree/card-properties'
import { phoneCardPropertyChoices, phoneShownCardProperties } from './phone-card-property-choices'

const ids = (choices: readonly { id: string }[]) => choices.map((choice) => choice.id)

describe('the card properties the phone offers', () => {
  it('is every shared choice but Ports, in the shared order', () => {
    expect(ids(phoneCardPropertyChoices(WORKSPACE_CARD_PROPERTY_CHOICES))).toEqual(
      ids(WORKSPACE_CARD_PROPERTY_CHOICES).filter((id) => id !== 'ports')
    )
    expect(ids(phoneCardPropertyChoices(WORKSPACE_CARD_DISPLAY_CHOICES))).toEqual(
      ids(WORKSPACE_CARD_DISPLAY_CHOICES).filter((id) => id !== 'ports')
    )
  })

  it('leaves Ports out of the count while keeping the shared value untouched', () => {
    expect(DEFAULT_WORKTREE_CARD_PROPERTIES).toContain('ports')
    expect(phoneShownCardProperties(DEFAULT_WORKTREE_CARD_PROPERTIES)).not.toContain('ports')
    expect(phoneShownCardProperties(['issue', 'ports', 'cli'])).toEqual(['issue', 'cli'])
  })
})
