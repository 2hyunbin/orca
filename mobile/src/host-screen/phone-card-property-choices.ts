import {
  WORKSPACE_CARD_DISPLAY_CHOICES,
  WORKSPACE_CARD_PROPERTY_CHOICES,
  type WorkspaceViewChoice
} from '../../../src/shared/workspace-view/workspace-view-options'
import type { WorktreeCardProperty } from '../../../src/shared/ui-chrome-types'

type CardPropertyChoiceId =
  | (typeof WORKSPACE_CARD_PROPERTY_CHOICES)[number]['id']
  | (typeof WORKSPACE_CARD_DISPLAY_CHOICES)[number]['id']

/** Whether the phone offers each shared card property; a new desktop choice fails to compile until classified. */
const PHONE_CARD_PROPERTY: Record<CardPropertyChoiceId, 'shown' | 'hidden'> = {
  issue: 'shown',
  'linear-issue': 'shown',
  'jira-issue': 'shown',
  pr: 'shown',
  automation: 'shown',
  cli: 'shown',
  comment: 'shown',
  // Product call: the phone has no port scan, and ports are not worth one.
  ports: 'hidden',
  'inline-agents': 'shown',
  host: 'shown',
  branch: 'shown'
}

const PHONE_CARD_PROPERTY_BY_ID: Partial<Record<WorktreeCardProperty, 'shown' | 'hidden'>> =
  PHONE_CARD_PROPERTY

function isShownOnPhone(id: WorktreeCardProperty): boolean {
  return PHONE_CARD_PROPERTY_BY_ID[id] === 'shown'
}

/** The shared choices the phone offers, in the shared order. */
export function phoneCardPropertyChoices<Choice extends WorkspaceViewChoice<WorktreeCardProperty>>(
  choices: readonly Choice[]
): Choice[] {
  return choices.filter((choice) => isShownOnPhone(choice.id))
}

/** The shown properties the phone counts, so its count matches the rows it lists. */
export function phoneShownCardProperties(
  properties: readonly WorktreeCardProperty[]
): WorktreeCardProperty[] {
  return properties.filter(isShownOnPhone)
}
