import {
  findCatalogModel,
  getAgentSessionOptionCatalog
} from '../../../../shared/agent-session-option-catalog'
import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { sourceControlActionChatOptions } from '../../../../shared/source-control-action-launch-preferences'
import { translate } from '@/i18n/i18n'

/** The saved model the launch runs, named the way the chat picker names it. */
export function describeSourceControlActionModel(
  agent: TuiAgent,
  preferences: SourceControlActionLaunchPreferences
): string {
  const model = findCatalogModel(
    getAgentSessionOptionCatalog(agent) ?? { models: [], modelApply: {} },
    preferences.model
  )
  const labels = sourceControlActionChatOptions(agent, preferences.model).flatMap((option) => {
    const value = preferences.options?.[option.id]
    return value && option.kind.type === 'select'
      ? [option.kind.choices.find((choice) => choice.value === value)?.label ?? value]
      : []
  })
  const modelLabel = model?.label ?? preferences.model
  return translate(
    'settings.sourceControl.actionModel.savedModel',
    'Model from Settings: {{value0}}',
    { value0: [modelLabel, ...labels].join(' · ') }
  )
}
