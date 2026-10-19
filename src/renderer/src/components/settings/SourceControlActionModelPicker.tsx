import {
  findCatalogModel,
  getAgentSessionOptionCatalog
} from '../../../../shared/agent-session-option-catalog'
import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import {
  sourceControlActionAgentPicksModel,
  sourceControlActionChatOptions,
  sourceControlActionPermissionModes
} from '../../../../shared/source-control-action-launch-preferences'
import { isAgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import {
  nativeChatPermissionModeLabel,
  nativeChatPermissionPickerTitle
} from '../native-chat/native-chat-permission-mode-labels'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

const AGENT_DEFAULT_VALUE = '__agent_default__'

type SourceControlActionModelPickerProps = {
  agent: TuiAgent | null | undefined
  value: SourceControlActionLaunchPreferences | undefined
  disabled?: boolean
  onChange: (value: SourceControlActionLaunchPreferences | undefined) => void
}

export function SourceControlActionModelPicker({
  agent,
  value,
  disabled,
  onChange
}: SourceControlActionModelPickerProps): React.JSX.Element | null {
  const picksModel = sourceControlActionAgentPicksModel(agent)
  const modes = sourceControlActionPermissionModes(agent)
  if (!agent || (!picksModel && modes.length === 0)) {
    return null
  }
  const catalog = picksModel ? getAgentSessionOptionCatalog(agent) : null
  const selected = value?.agentId === agent ? value : undefined
  // Model and permission mode are saved independently; a model change keeps the mode.
  const save = (next: Omit<SourceControlActionLaunchPreferences, 'agentId'>): void =>
    onChange(
      next.model || next.permissionMode
        ? {
            agentId: agent,
            ...(next.model
              ? { model: next.model, ...(next.options ? { options: next.options } : {}) }
              : {}),
            ...(next.permissionMode ? { permissionMode: next.permissionMode } : {})
          }
        : undefined
    )
  const { permissionMode } = selected ?? {}
  const unlistedModel =
    catalog && selected?.model && !findCatalogModel(catalog, selected.model)
      ? selected.model
      : undefined
  const options = selected?.model ? sourceControlActionChatOptions(agent, selected.model) : []
  // Model and Permissions take full rows so long values stay readable in the narrow column.
  return (
    <div className="grid auto-rows-[minmax(56.5px,auto)] grid-cols-2 gap-2">
      {catalog ? (
        <div className="col-span-2 space-y-2">
          <Label>{translate('settings.sourceControl.actionModel.model', 'Model')}</Label>
          <Select
            value={selected?.model ?? AGENT_DEFAULT_VALUE}
            disabled={disabled}
            onValueChange={(model) =>
              save({ ...(model === AGENT_DEFAULT_VALUE ? {} : { model }), permissionMode })
            }
          >
            <SelectTrigger size="sm" className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AGENT_DEFAULT_VALUE}>
                {translate('settings.sourceControl.actionModel.agentDefault', 'Agent default')}
              </SelectItem>
              {catalog.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
              {unlistedModel ? (
                <SelectItem value={unlistedModel}>{unlistedModel}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {modes.length > 0 ? (
        <div className="col-span-2 space-y-2">
          <Label>{nativeChatPermissionPickerTitle()}</Label>
          <Select
            value={permissionMode ?? AGENT_DEFAULT_VALUE}
            disabled={disabled}
            onValueChange={(next) =>
              save({
                model: selected?.model,
                options: selected?.options,
                permissionMode: isAgentChatPermissionMode(next) ? next : undefined
              })
            }
          >
            <SelectTrigger size="sm" className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AGENT_DEFAULT_VALUE}>
                {translate(
                  'settings.sourceControl.actionModel.permissionsDefault',
                  'Same as new chats'
                )}
              </SelectItem>
              {[
                ...modes,
                ...(permissionMode && !modes.includes(permissionMode) ? [permissionMode] : [])
              ].map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {nativeChatPermissionModeLabel(mode)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {selected?.model
        ? options.map((option) => {
            const choices =
              option.kind.type === 'select'
                ? option.kind.choices
                : [
                    {
                      value: 'true',
                      label: translate('settings.sourceControl.actionModel.on', 'On')
                    },
                    {
                      value: 'false',
                      label: translate('settings.sourceControl.actionModel.off', 'Off')
                    }
                  ]
            const current = selected.options?.[option.id]
            return (
              <div key={option.id} className="space-y-2">
                <Label>{option.label}</Label>
                <Select
                  value={current ?? AGENT_DEFAULT_VALUE}
                  disabled={disabled}
                  onValueChange={(next) => {
                    const { [option.id]: _old, ...rest } = selected.options ?? {}
                    const encoded =
                      next === AGENT_DEFAULT_VALUE
                        ? null
                        : encodeStructuredAgentSessionOptionValue(
                            option.id,
                            option.kind.type === 'boolean' ? next === 'true' : next
                          )
                    const values = {
                      ...rest,
                      ...(encoded === null ? {} : { [option.id]: encoded })
                    }
                    onChange({ ...selected, options: values })
                  }}
                >
                  <SelectTrigger size="sm" className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AGENT_DEFAULT_VALUE}>
                      {translate('settings.sourceControl.actionModel.effortDefault', 'Default')}
                    </SelectItem>
                    {choices.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                    {current && !choices.some((choice) => choice.value === current) ? (
                      <SelectItem value={current}>{current}</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </div>
            )
          })
        : null}
    </div>
  )
}
