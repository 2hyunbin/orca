import {
  isBundledSkillLeaveReason,
  type BundledSkillPlan
} from '../../../../shared/bundled-skill-plan'
import type {
  BundledSkillOutcomeText,
  BundledSkillResultSummary
} from '../../../../shared/bundled-skill-summary'
import { collapseHomePath } from '../../../../shared/bundled-skill-locations'
import { leaveReasonText, locationPlaceLabel, skillOutcomeText } from '../skills/skill-plan-op-copy'
import {
  bundledSkillSetupResultHeadline,
  type BundledSkillSetupChanges
} from './bundled-skill-setup-copy'
import { translate } from '@/i18n/i18n'

const RESULT_HEADLINE_ORDER: readonly BundledSkillOutcomeText[] = [
  'Needs attention',
  'Updated',
  'Installed',
  'Linked'
]

export function bundledSkillSetupAttentionMessage(plan: BundledSkillPlan): string {
  const blocked = plan.skills
    .flatMap((entry) => entry.ops)
    .find(
      (op) =>
        op.kind === 'leave' && !op.replaceable && op.reason && isBundledSkillLeaveReason(op.reason)
    )
  switch (blocked?.reason) {
    case 'unwritable':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionUnwritable',
        "Needs attention · Orca can't write to {{folder}}",
        { folder: collapseHomePath(blocked.path, plan.homeDirectory) }
      )
    case 'busy':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionBusy',
        'Needs attention · Another skill install is still finishing here'
      )
    case 'unreadable':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionUnreadable',
        "Needs attention · Orca can't read every file in this copy"
      )
    case 'edited':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionEdited',
        'Needs attention · You edited this copy'
      )
    case 'other':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionOther',
        'Needs attention · A different skill already uses this name'
      )
    case 'shared-not-current':
      return translate(
        'auto.components.settings.bundledSkillSetupCopy.attentionSharedNotCurrent',
        'Needs attention · The shared copy this folder uses is not Orca’s'
      )
    case undefined:
      return translate('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
  }
}

export function skillInstallResultLine(
  summary: BundledSkillResultSummary,
  changes?: BundledSkillSetupChanges
): string {
  const texts = new Set(summary.skills.map((skill) => skill.text))
  const headline =
    changes && summary.ok && !texts.has('Needs attention')
      ? bundledSkillSetupResultHeadline(changes)
      : skillOutcomeText(RESULT_HEADLINE_ORDER.find((text) => texts.has(text)) ?? 'No change')
  const notUpdated = summary.skills.flatMap((skill) => skill.leftAlone)
  if (notUpdated.length === 0) {
    return headline
  }
  const reasons = [...new Set(notUpdated.map((left) => left.code))]
    .map((reason) =>
      reason === 'edited' && notUpdated.filter((left) => left.code === reason).length > 1
        ? translate(
            'auto.components.settings.bundledSkillSetupCopy.editedCopies',
            'you edited these copies'
          )
        : leaveReasonText(reason)
    )
    .join('; ')
  if (notUpdated.length > 1) {
    return translate(
      'auto.components.settings.bundledSkillSetupCopy.resultNotUpdatedPlaces',
      '{{result}} · Not updated in {{places}} places: {{reason}}',
      { result: headline, places: notUpdated.length, reason: reasons }
    )
  }
  const location = changes?.notUpdated.find((location) => location.path === notUpdated[0].path)
  return translate(
    'auto.components.settings.bundledSkillSetupCopy.resultNotUpdatedAgent',
    '{{result}} · Not updated in {{agent}}: {{reason}}',
    {
      result: headline,
      agent: location ? locationPlaceLabel(location) : notUpdated[0].path,
      reason: reasons
    }
  )
}
