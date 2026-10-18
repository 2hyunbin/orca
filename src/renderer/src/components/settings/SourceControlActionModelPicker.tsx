import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog,
  type CatalogOption
} from '../../../../shared/agent-session-option-catalog'
import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import { sourceControlActionAgentPicksModel } from '../../../../shared/source-control-action-launch-preferences'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { CustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

const AGENT_DEFAULT_VALUE = '__agent_default__'

type SourceControlActionModelPickerProps = {
  agent: TuiAgent | CustomAgentId | null
  value: SourceControlActionLaunchPreferences | undefined
  disabled?: boolean
  onChange: (value: SourceControlActionLaunchPreferences | undefined) => void
}

function effortOptionFor(
  agent: TuiAgent,
  modelId: string | undefined
): Extract<CatalogOption['kind'], { type: 'select' }> | null {
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog || !modelId) {
    return null
  }
  const model = findCatalogModel(catalog, modelId)
  const option =
    findCatalogOption(model, 'effort') ??
    (model
      ? undefined
      : catalog.unknownModelOptions?.find((candidate) => candidate.id === 'effort'))
  return option?.kind.type === 'select' ? option.kind : null
}

/** The action's model and effort: data both routes apply, unlike CLI arguments. */
export function SourceControlActionModelPicker({
  agent,
  value,
  disabled,
  onChange
}: SourceControlActionModelPickerProps): React.JSX.Element | null {
  if (!sourceControlActionAgentPicksModel(agent)) {
    return null
  }
  const models = getAgentSessionOptionCatalog(agent)?.models ?? []
  // Keeps a saved id the catalog no longer lists selectable, so the row shows what will run.
  const savedUnlisted = value && !models.some((model) => model.id === value.model)
  const effort = effortOptionFor(agent, value?.model)

  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">
          {translate('settings.sourceControl.actionModel.model', 'Model')}
        </Label>
        <Select
          value={value?.model ?? AGENT_DEFAULT_VALUE}
          disabled={disabled}
          onValueChange={(next) =>
            onChange(next === AGENT_DEFAULT_VALUE ? undefined : { model: next })
          }
        >
          <SelectTrigger size="sm" className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AGENT_DEFAULT_VALUE}>
              {translate('settings.sourceControl.actionModel.agentDefault', 'Agent default')}
            </SelectItem>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
            {savedUnlisted ? <SelectItem value={value.model}>{value.model}</SelectItem> : null}
          </SelectContent>
        </Select>
      </div>
      {value && effort ? (
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {translate('settings.sourceControl.actionModel.effort', 'Effort')}
          </Label>
          <Select
            value={value.effort ?? AGENT_DEFAULT_VALUE}
            disabled={disabled}
            onValueChange={(next) =>
              onChange(
                next === AGENT_DEFAULT_VALUE
                  ? { model: value.model }
                  : { model: value.model, effort: next }
              )
            }
          >
            <SelectTrigger size="sm" className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AGENT_DEFAULT_VALUE}>
                {translate('settings.sourceControl.actionModel.effortDefault', 'Default')}
              </SelectItem>
              {effort.choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  )
}
