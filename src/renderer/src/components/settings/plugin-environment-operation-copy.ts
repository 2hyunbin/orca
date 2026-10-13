import type { EnvironmentRecipeAction } from '../../../../shared/environment-recipe-protocol'
import type { EnvironmentRecipeJournalOperation } from '../../../../shared/plugins/plugin-environment-recipe-journal'
import { translate } from '@/i18n/i18n'

export function environmentOperationActionLabel(action: EnvironmentRecipeAction): string {
  const labels = {
    create: 'Create',
    list: 'Refresh inventory',
    sleep: 'Sleep',
    resume: 'Wake',
    archive: 'Archive',
    delete: 'Delete'
  }
  return translate(
    `auto.components.settings.PluginEnvironmentOperationHistory.action.${action}`,
    labels[action]
  )
}
export function environmentOperationObservationLabel(
  operation: EnvironmentRecipeJournalOperation
): string {
  switch (operation.status) {
    case 'pending':
      return translate(
        'auto.components.settings.PluginEnvironmentOperationHistory.noResponse',
        'No final response'
      )
    case 'unverifiable':
      return translate(
        'auto.components.settings.PluginEnvironmentOperationHistory.notConfirmed',
        'Not confirmed'
      )
    case 'refused':
      return translate(
        'auto.components.settings.PluginEnvironmentOperationHistory.notStarted',
        'Not started'
      )
    case 'completed':
      return translate(
        'auto.components.settings.PluginEnvironmentOperationHistory.responded',
        'Response received'
      )
  }
}
export function environmentOperationOutcomeLabel(
  operation: EnvironmentRecipeJournalOperation
): string {
  const recovery = operation.recovery
  if (!recovery) {
    return environmentOperationObservationLabel(operation)
  }
  return recovery.receipt.outcome.kind === 'completed'
    ? translate(
        'auto.components.settings.PluginEnvironmentOperationHistory.confirmedCompleted',
        'Provider confirmed completion'
      )
    : translate(
        'auto.components.settings.PluginEnvironmentOperationHistory.confirmedRefused',
        'Provider confirmed no change'
      )
}
