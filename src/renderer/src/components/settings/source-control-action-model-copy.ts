import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from '../../../../shared/agent-session-option-catalog'
import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

export function getLaunchActionAgentArgsNote(): string {
  return translate(
    'settings.sourceControl.actionModel.argsTerminalOnly',
    'Used only when the agent opens in a terminal; chats ignore them.'
  )
}

/** The saved model the launch runs, named the way the chat picker names it. */
export function describeSourceControlActionModel(
  agent: TuiAgent,
  preferences: SourceControlActionLaunchPreferences
): string {
  const model = findCatalogModel(
    getAgentSessionOptionCatalog(agent) ?? { models: [], modelApply: {} },
    preferences.model
  )
  const effortOption = findCatalogOption(model, 'effort')
  const effortLabel =
    preferences.effort && effortOption?.kind.type === 'select'
      ? (effortOption.kind.choices.find((choice) => choice.value === preferences.effort)?.label ??
        preferences.effort)
      : preferences.effort
  const modelLabel = model?.label ?? preferences.model
  return translate(
    'settings.sourceControl.actionModel.savedModel',
    'Model from Settings: {{value0}}',
    { value0: effortLabel ? `${modelLabel} · ${effortLabel}` : modelLabel }
  )
}
