import {
  findCatalogModel,
  getAgentSessionOptionCatalog
} from '../../../../shared/agent-session-option-catalog'
import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import {
  sourceControlActionAgentPicksModel,
  sourceControlActionChatOptions
} from '../../../../shared/source-control-action-launch-preferences'
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
  if (!sourceControlActionAgentPicksModel(agent)) {
    return null
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog) {
    return null
  }
  const selected = value?.agentId === agent ? value : undefined
  const unlisted = selected && !findCatalogModel(catalog, selected.model)
  const options = selected ? sourceControlActionChatOptions(agent, selected.model) : []
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="space-y-2">
        <Label className="text-[11px] text-muted-foreground">
          {translate('settings.sourceControl.actionModel.model', 'Model')}
        </Label>
        <Select
          value={selected?.model ?? AGENT_DEFAULT_VALUE}
          disabled={disabled}
          onValueChange={(model) =>
            onChange(model === AGENT_DEFAULT_VALUE ? undefined : { agentId: agent, model })
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
            {unlisted ? <SelectItem value={selected.model}>{selected.model}</SelectItem> : null}
          </SelectContent>
        </Select>
      </div>
      {selected &&
        options.map((option) => {
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
              <Label className="text-[11px] text-muted-foreground">{option.label}</Label>
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
                  const values = { ...rest, ...(encoded === null ? {} : { [option.id]: encoded }) }
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
        })}
    </div>
  )
}
