import {
  findCatalogModel,
  getAgentSessionOptionCatalog
} from '../../../../shared/agent-session-option-catalog'
import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { sourceControlActionChatOptions } from '../../../../shared/source-control-action-launch-preferences'
import { translate } from '@/i18n/i18n'
import { nativeChatPermissionModeLabel } from '../native-chat/native-chat-permission-mode-labels'

/** The saved model and permission mode the launch runs, named the way the chat pickers name them. */
export function describeSourceControlActionModel(
  agent: TuiAgent,
  preferences: SourceControlActionLaunchPreferences
): string {
  const { model: modelId, permissionMode } = preferences
  const catalog = getAgentSessionOptionCatalog(agent) ?? { models: [], modelApply: {} }
  const labels = modelId
    ? [
        findCatalogModel(catalog, modelId)?.label ?? modelId,
        ...sourceControlActionChatOptions(agent, modelId).flatMap((option) => {
          const value = preferences.options?.[option.id]
          return value && option.kind.type === 'select'
            ? [option.kind.choices.find((choice) => choice.value === value)?.label ?? value]
            : []
        })
      ]
    : []
  if (!permissionMode) {
    return translate(
      'settings.sourceControl.actionModel.savedModel',
      'Model from Settings: {{value0}}',
      { value0: labels.join(' · ') }
    )
  }
  return translate(
    'settings.sourceControl.actionModel.savedChatOptions',
    'Chat options from Settings: {{value0}}',
    { value0: [...labels, nativeChatPermissionModeLabel(permissionMode)].join(' · ') }
  )
}
