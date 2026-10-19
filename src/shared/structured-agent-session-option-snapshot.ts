// A structured chat's picker: the chat's own values, drawn under the controls of the model they apply to.

import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog'
import {
  nativeChatSessionOptionDescriptors,
  withTrackedNativeChatModel,
  type NativeChatShownModel
} from './native-chat-session-option-snapshot'
import type { SessionOptionDescriptor, SessionOptionValue } from './native-chat-session-options'
import type { TrackedNativeChatSessionOption } from './native-chat-session-option-state'
import { serviceTierOption } from './structured-agent-session-discovered-model'
import {
  structuredAgentSessionModelId,
  type StructuredAgentSessionOptionRecord
} from './structured-agent-session-option-state'
import { withUnlistedEffort } from './structured-agent-session-unlisted-effort'
import { structuredAgentSessionPermissionDescriptor } from './structured-agent-session-permission-option'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

/** Before the host answers, or an agent with no list reports, the quiet model pill: never
 *  pickable, so displaying it can never become a launch pick. */
const PROVIDER_DEFAULT_MODEL_PLACEHOLDER: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: { type: 'select', choices: [] },
  valueSource: 'unknown',
  transport: 'agent-session',
  settable: false,
  disabledReason: 'available-after-session-start'
}

/** Which model the trigger names, and which model's controls apply. A catalog default is named
 *  only where the host says this launch runs it; otherwise it stands in for controls alone. */
export function structuredAgentSessionShownModel(
  catalog: AgentSessionOptionCatalog,
  models: readonly CatalogModel[],
  record: StructuredAgentSessionOptionRecord
): { shown: NativeChatShownModel; controlsModelId: string | null; isCliDefault: boolean } {
  const own = structuredAgentSessionModelId(record, 'own')
  const supplied = structuredAgentSessionModelId(record, 'any')
  const defaultId =
    own || !catalog.defaultModelIsCliDefault
      ? null
      : (supplied ?? models.find((model) => model.isDefault)?.id ?? null)
  const currentId = own ?? defaultId
  return {
    shown: {
      currentId,
      valueSource: own
        ? (record.values.model?.source ?? 'unknown')
        : defaultId
          ? 'default'
          : 'unknown',
      tracked: own ? record.values.model : undefined
    },
    controlsModelId: currentId ?? supplied,
    isCliDefault: currentId !== null && currentId === defaultId
  }
}

/** The row the list describes `modelId` by; none for a model it lacks, or one outside the rows the
 *  chat's own listing names, which says nothing about what it takes. */
export function structuredAgentSessionDescribedModel(
  state: Pick<StructuredAgentSessionOptionState, 'catalog' | 'verifiedModelIds'>,
  modelId: string
): CatalogModel | undefined {
  const model = state.catalog?.models.find((entry) => entry.id === modelId)
  return model && (!state.verifiedModelIds || state.verifiedModelIds.includes(modelId))
    ? model
    : undefined
}

/** What the named model's controls draw. A select value another listed model offers but this one
 *  doesn't is what the host replaces with the default, so the row draws that; the record keeps the
 *  host's value. Effort (the host keeps and runs it) and a value no listed model offers stay as
 *  held. A send that ever carries one of these values must read it through here. */
function valuesUnderControls(
  catalog: AgentSessionOptionCatalog,
  controls: readonly CatalogOption[],
  values: Readonly<Record<string, TrackedNativeChatSessionOption>>
): Readonly<Record<string, TrackedNativeChatSessionOption>> {
  let drawn = values
  for (const option of controls) {
    const tracked = values[option.id]
    const offers = (entry: CatalogOption): boolean =>
      entry.id === option.id &&
      entry.kind.type === 'select' &&
      entry.kind.choices.some((choice) => choice.value === tracked?.value)
    if (
      option.kind.type === 'select' &&
      option.id !== 'effort' &&
      tracked &&
      !offers(option) &&
      catalog.models.some((model) => model.options.some(offers))
    ) {
      drawn = { ...drawn, [option.id]: { value: option.kind.defaultValue, source: 'default' } }
    }
  }
  return drawn
}

/** With no model known, a saved speed other than Standard still shows, and Standard turns it off. */
function modellessControls(
  catalog: AgentSessionOptionCatalog,
  record: StructuredAgentSessionOptionRecord
): CatalogOption[] {
  const tier = record.values.serviceTier?.value
  if (typeof tier !== 'string' || tier === 'default') {
    return []
  }
  const named = catalog.models
    .flatMap((model) => model.options)
    .flatMap((option) =>
      option.id === 'serviceTier' && option.kind.type === 'select' ? option.kind.choices : []
    )
    .find((choice) => choice.value === tier)
  return [serviceTierOption([named ?? { value: tier, label: tier }])]
}

function modelOptionSnapshot(state: StructuredAgentSessionOptionState): SessionOptionDescriptor[] {
  const { catalog, record } = state
  if (!catalog) {
    return []
  }
  // Until the host answers, the built-in list would paint a label its list may replace.
  if (state.catalogSource === 'seed') {
    return [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
  }
  // A seeded default can name a model the static seed does not list yet.
  const models = withTrackedNativeChatModel(catalog, catalog.models, { model: record.values.model })
  const { shown, controlsModelId, isCliDefault } = structuredAgentSessionShownModel(
    catalog,
    models,
    record
  )
  const controls = controlsModelId
    ? (models.find((model) => model.id === controlsModelId)?.options ?? [])
    : modellessControls(catalog, record)
  // Only the named model's listed controls speak for its values; a stand-in's or an unlisted
  // model's draw what the host holds.
  const normalises =
    shown.currentId !== null && structuredAgentSessionDescribedModel(state, shown.currentId)
  const snapshot =
    models.length === 0
      ? []
      : nativeChatSessionOptionDescriptors({
          catalog,
          models,
          mode: 'live',
          modelLabel: 'Model',
          liveTransport: 'agent-session',
          model: shown,
          controls,
          values: normalises
            ? valuesUnderControls(catalog, controls, record.values)
            : record.values,
          modelIsCliDefault: isCliDefault
        })
  return snapshot.length > 0 || state.catalogSource === 'live'
    ? withUnlistedEffort(
        catalog,
        controlsModelId,
        record.values.effort,
        state.verifiedModelIds,
        snapshot
      )
    : [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
}

export function structuredAgentSessionOptionSnapshot(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor[] {
  const permission = structuredAgentSessionPermissionDescriptor(state)
  const options = modelOptionSnapshot(state)
  return permission ? [...options, permission] : options
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

export function canSetStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: SessionOptionValue
): boolean {
  const descriptor = structuredAgentSessionOptionSnapshot(state).find((entry) => entry.id === id)
  return Boolean(
    state.catalog &&
    state.pendingId !== id &&
    ((typeof value === 'string' &&
      descriptor?.kind.type === 'select' &&
      descriptor.kind.choices.some((choice) => choice.value === value)) ||
      (typeof value === 'boolean' && descriptor?.kind.type === 'boolean'))
  )
}
