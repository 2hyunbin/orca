import { discoveredModel } from './structured-agent-session-discovered-model'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'
import type { SessionOptionDescriptor } from './native-chat-session-options'
import {
  buildNativeChatSessionOptionSnapshot,
  resolveEffectiveNativeChatModelId,
  withTrackedNativeChatModel
} from './native-chat-session-option-snapshot'
import { getTrackedSessionOption } from './native-chat-session-option-state'
import { structuredAgentSessionPermissionDescriptor } from './structured-agent-session-permission-option'

/** Before the host answers, or an agent with no list reports, the quiet model pill: never
 *  pickable, so displaying it can never become a launch pick. */
const PROVIDER_DEFAULT_MODEL_PLACEHOLDER: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: { type: 'select', choices: [] },
  valueSource: 'unknown',
  transport: 'agent-session',
  settable: false
}

export function structuredAgentSessionOptionSnapshot(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor[] {
  const permission = structuredAgentSessionPermissionDescriptor(state)
  const options = modelOptionSnapshot(state)
  return permission ? [...options, permission] : options
}

function modelOptionSnapshot(state: StructuredAgentSessionOptionState): SessionOptionDescriptor[] {
  if (!state.catalog) {
    return []
  }
  // Until the host answers, the built-in list would paint a label its list may replace.
  if (state.catalogSource === 'seed' && !state.record.model) {
    return [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
  }
  const catalog = state.catalogSource === 'seed' ? { ...state.catalog, models: [] } : state.catalog
  const model = resolveEffectiveNativeChatModelId(catalog, catalog.models, state.record)
  const current = state.currentModelMetadata?.id === model ? state.currentModelMetadata : null
  const models = withTrackedNativeChatModel(catalog, catalog.models, state.record).map((row) =>
    current && row.id === current.id
      ? {
          ...row,
          options: [
            ...row.options.filter(
              (option) =>
                !['effort', 'fastMode', 'serviceTier'].includes(option.id) ||
                (option.id === 'effort' && current.effortsKnown === false)
            ),
            ...discoveredModel(current, true).options
          ]
        }
      : row
  )
  const snapshot = buildNativeChatSessionOptionSnapshot({
    catalog,
    // A seeded default can name a model the static seed does not list yet.
    models,
    record: state.record,
    mode: 'live',
    modelLabel: 'Model',
    liveTransport: 'agent-session'
  })
  const effort = getTrackedSessionOption(state.record, model, 'effort')
  if (typeof effort?.value === 'string' && !snapshot.some((entry) => entry.id === 'effort')) {
    const label =
      current?.efforts.find((choice) => choice.value === effort.value)?.label ??
      state.catalog.models
        .flatMap((row) => row.options)
        .flatMap((option) =>
          option.id === 'effort' && option.kind.type === 'select' ? option.kind.choices : []
        )
        .find((choice) => choice.value === effort.value)?.label ??
      effort.value
    snapshot.push({
      id: 'effort',
      label: 'Reasoning effort',
      category: 'thought_level',
      kind: {
        type: 'select',
        currentValue: effort.value,
        choices: [{ value: effort.value, label }]
      },
      valueSource: effort.source,
      transport: 'agent-session',
      settable: false
    })
  }
  return snapshot.length > 0 || state.catalogSource === 'live'
    ? snapshot
    : [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
}

/** No launch holds a pick and no fence can carry one yet, so the picker only shows. */
export function lockedStructuredAgentSessionOptionSnapshot(
  snapshot: readonly SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  return snapshot.map((descriptor) => ({
    ...descriptor,
    settable: false,
    disabledReason: 'available-after-session-start'
  }))
}
