import { isBundledSkillLeaveReason } from '../../../../shared/bundled-skill-plan'
import type {
  BundledSkillLocation,
  BundledSkillLocationState
} from '../../../../shared/bundled-skill-locations'
import type {
  BundledSkillOutcomeText,
  BundledSkillPlanState
} from '../../../../shared/bundled-skill-summary'
import { SKILL_INSTALL_PROVIDERS } from '../../../../shared/skill-install-providers'
import { translate } from '@/i18n/i18n'

export function leaveReasonText(reason: string | null | undefined): string {
  if (!reason || !isBundledSkillLeaveReason(reason)) {
    return translate('auto.components.skills.skillPlanOpCopy.leftAsIs', 'Left as it is')
  }
  switch (reason) {
    case 'edited':
      return translate('auto.components.skills.skillPlanOpCopy.edited', "You've changed this copy")
    case 'other':
      return translate(
        'auto.components.skills.skillPlanOpCopy.other',
        'A different skill already uses this name'
      )
    case 'unwritable':
      return translate(
        'auto.components.skills.skillPlanOpCopy.unwritable',
        "Orca can't write to this folder"
      )
    case 'busy':
      return translate(
        'auto.components.skills.skillPlanOpCopy.busy',
        'Another skill install is still finishing here'
      )
    case 'shared-not-current':
      return translate(
        'auto.components.skills.skillPlanOpCopy.sharedNotCurrent',
        'The shared copy this folder uses is not Orca’s'
      )
  }
}

/** "Shared folder", or the agents that read this folder. */
export function locationPlaceLabel(location: BundledSkillLocation): string {
  if (location.place.kind === 'shared') {
    return translate('auto.components.skills.skillPlanOpCopy.sharedFolder', 'Shared folder')
  }
  return location.place.names.join(', ') || location.displayPath
}

/** What Update does at one location, for the "Show all locations" table. */
export function locationStateText(location: BundledSkillLocation): string {
  const texts: Record<BundledSkillLocationState, () => string> = {
    update: () => translate('auto.components.skills.skillPlanOpCopy.update', 'Will update'),
    repair: () => translate('auto.components.skills.skillPlanOpCopy.repair', 'Will repair'),
    install: () => translate('auto.components.skills.skillPlanOpCopy.write', 'Will install'),
    link: () => translate('auto.components.skills.skillPlanOpCopy.link', 'Will link'),
    replace: () => translate('auto.components.skills.skillPlanOpCopy.replace', 'Will replace'),
    keep: () => translate('auto.components.skills.skillPlanOpCopy.keep', 'No change'),
    'keep-link': () =>
      translate('auto.components.skills.skillPlanOpCopy.keepLink', 'Link, no change'),
    leave: () =>
      translate('auto.components.skills.skillPlanOpCopy.leftAlone', 'Left alone: {{value0}}', {
        value0: leaveReasonText(location.reason)
      }),
    unknown: () =>
      translate('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
  }
  return texts[location.state]()
}

/** The skill row's line before Update runs; null when only its locations need saying. */
export function skillPlanHeadline(state: BundledSkillPlanState): string | null {
  switch (state) {
    case 'update':
      return translate('auto.components.skills.skillPlanOpCopy.update', 'Will update')
    case 'repair':
      return translate('auto.components.skills.skillPlanOpCopy.repair', 'Will repair')
    case 'install':
      return translate('auto.components.skills.skillPlanOpCopy.write', 'Will install')
    case 'attention':
    case 'current':
      return null
  }
}

export function skillOutcomeText(text: BundledSkillOutcomeText): string {
  switch (text) {
    case 'Updated':
      return translate('auto.components.skills.skillPlanOpCopy.updated', 'Updated')
    case 'Installed':
      return translate('auto.components.skills.skillPlanOpCopy.installed', 'Installed')
    case 'Linked':
      return translate('auto.components.skills.skillPlanOpCopy.linked', 'Linked')
    case 'No change':
      return translate('auto.components.skills.skillPlanOpCopy.keep', 'No change')
    case 'Needs attention':
      return translate('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
  }
}

export function agentNames(agents: readonly string[]): string {
  return agents
    .map((agent) => SKILL_INSTALL_PROVIDERS.find((provider) => provider.id === agent)?.displayName)
    .filter((name): name is string => Boolean(name))
    .join(', ')
}

export function installForAgentsLabel(agents: readonly string[]): string {
  const names = agentNames(agents)
  if (!names) {
    return translate('auto.components.skills.skillPlanOpCopy.install', 'Install')
  }
  return translate('auto.components.skills.skillPlanOpCopy.installFor', 'Install for {{value0}}', {
    value0: names
  })
}
