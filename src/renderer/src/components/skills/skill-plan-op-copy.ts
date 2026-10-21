import type {
  BundledSkillLeaveReason,
  BundledSkillOp,
  BundledSkillOpOutcome
} from '../../../../shared/bundled-skill-plan'
import {
  isBundledSkillLeaveReason,
  isBundledSkillOpKind
} from '../../../../shared/bundled-skill-plan'
import type {
  BundledSkillOutcomeSummary,
  BundledSkillOutcomeText
} from '../../../../shared/bundled-skill-summary'
import { SKILL_INSTALL_PROVIDERS } from '../../../../shared/skill-install-providers'
import { translate } from '@/i18n/i18n'

export function leaveReasonText(reason: string | undefined): string {
  if (!reason || !isBundledSkillLeaveReason(reason)) {
    return translate('auto.components.skills.skillPlanOpCopy.leftAsIs', 'Left as it is')
  }
  const texts: Record<BundledSkillLeaveReason, () => string> = {
    edited: () =>
      translate('auto.components.skills.skillPlanOpCopy.edited', "You've changed this copy"),
    other: () =>
      translate(
        'auto.components.skills.skillPlanOpCopy.other',
        'A different skill already uses this name'
      ),
    unwritable: () =>
      translate(
        'auto.components.skills.skillPlanOpCopy.unwritable',
        "Orca can't write to this folder"
      ),
    busy: () =>
      translate(
        'auto.components.skills.skillPlanOpCopy.busy',
        'Another skill install is still finishing here'
      ),
    'shared-not-current': () =>
      translate(
        'auto.components.skills.skillPlanOpCopy.sharedNotCurrent',
        'The shared copy this folder uses is not Orca’s'
      )
  }
  return texts[reason]()
}

function leftAlone(reason: string | undefined): string {
  return translate('auto.components.skills.skillPlanOpCopy.leftAlone', 'Left alone: {{value0}}', {
    value0: leaveReasonText(reason)
  })
}

/** What Update will do at one location, before it runs. */
export function planOpLabel(op: Pick<BundledSkillOp, 'kind' | 'reason'>): string {
  if (!isBundledSkillOpKind(op.kind)) {
    return translate('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
  }
  switch (op.kind) {
    case 'keep':
      return translate('auto.components.skills.skillPlanOpCopy.keep', 'No change')
    case 'write':
    case 'copy':
      return translate('auto.components.skills.skillPlanOpCopy.write', 'Will install')
    case 'update':
      return translate('auto.components.skills.skillPlanOpCopy.update', 'Will update')
    case 'link':
      return translate('auto.components.skills.skillPlanOpCopy.link', 'Will link')
    case 'replace':
      return translate('auto.components.skills.skillPlanOpCopy.replace', 'Will replace')
    case 'restore':
      return translate('auto.components.skills.skillPlanOpCopy.restore', 'Needs repair')
    case 'leave':
      return leftAlone(op.reason)
  }
}

/** What Update did at one location. */
export function opOutcomeLabel(outcome: BundledSkillOpOutcome): string {
  switch (outcome.status) {
    case 'changed':
      return translate(
        'auto.components.skills.skillPlanOpCopy.changed',
        'Changed since you reviewed it'
      )
    case 'skipped':
      return translate('auto.components.skills.skillPlanOpCopy.skipped', 'Skipped')
    case 'failed':
      return translate('auto.components.skills.skillPlanOpCopy.failed', 'Failed: {{value0}}', {
        value0: outcome.error ?? 'unknown'
      })
    case 'done':
      break
  }
  if (!isBundledSkillOpKind(outcome.kind)) {
    return translate('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
  }
  switch (outcome.kind) {
    case 'keep':
      return translate('auto.components.skills.skillPlanOpCopy.keep', 'No change')
    case 'write':
    case 'copy':
      return translate('auto.components.skills.skillPlanOpCopy.installed', 'Installed')
    case 'update':
      return translate('auto.components.skills.skillPlanOpCopy.updated', 'Updated')
    case 'link':
      return translate('auto.components.skills.skillPlanOpCopy.linked', 'Linked')
    case 'replace':
      return translate('auto.components.skills.skillPlanOpCopy.replaced', 'Replaced')
    case 'restore':
      return translate('auto.components.skills.skillPlanOpCopy.restored', 'Restored')
    case 'leave':
      return leftAlone(outcome.reason)
  }
}

function outcomeText(text: BundledSkillOutcomeText): string {
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

/** e.g. "Updated · 1 left alone: You've changed this copy". */
export function skillOutcomeLine(summary: BundledSkillOutcomeSummary): string {
  const text = outcomeText(summary.text)
  if (summary.leftAlone.length === 0) {
    return text
  }
  const reasons = [...new Set(summary.leftAlone.map((left) => leaveReasonText(left.code ?? '')))]
  return translate(
    'auto.components.skills.skillPlanOpCopy.outcomeWithLeftAlone',
    '{{value0}} · {{value1}} left alone: {{value2}}',
    { value0: text, value1: summary.leftAlone.length, value2: reasons.join('; ') }
  )
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
