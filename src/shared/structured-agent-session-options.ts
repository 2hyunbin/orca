import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog'
import { hasRuntimeRpcErrorCode } from './runtime-rpc-error-code'
import { discoveredModel } from './structured-agent-session-discovered-model'
import { resolveEffectiveNativeChatModelId } from './native-chat-session-option-snapshot'
import { structuredAgentSessionOptionSnapshot } from './structured-agent-session-option-snapshot'
export {
  structuredAgentSessionOptionSnapshot,
  lockedStructuredAgentSessionOptionSnapshot
} from './structured-agent-session-option-snapshot'
import {
  applyNativeChatReportedSessionOptions,
  clearTrackedSessionOption,
  cloneNativeChatSessionOptionRecord,
  createNativeChatSessionOptionRecord,
  getTrackedSessionOption,
  setTrackedSessionOption,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'
import {
  STRUCTURED_LAUNCH_OPTION_IDS,
  STRUCTURED_LAUNCH_SEED_OPTION_IDS
} from './native-chat-session-option-defaults'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'
import type { SessionOptionValue } from './native-chat-session-options'
import type {
  AgentSessionModelOption,
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from './agent-session-wire'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from './structured-agent-session-option-codec'

export function structuredAgentSessionOptionCatalog(
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult
): AgentSessionOptionCatalog {
  const models: CatalogModel[] = result.models.map((model) =>
    discoveredModel(model, result.fastModeSupport?.supported === true)
  )
  if (result.current.model && !models.some((model) => model.id === result.current.model)) {
    models.push({
      id: result.current.model,
      label: result.current.model,
      options: []
    })
  }
  return { ...seed, models, defaultModelIsCliDefault: true }
}

export type StructuredAgentSessionOptionState = {
  catalog: AgentSessionOptionCatalog | null
  /** Inventory source for loading presentation, independent of current values. */
  catalogSource: 'seed' | 'builtin' | 'host' | 'live' | null
  /** Exact selected-row controls, cleared when their child or selection changes. */
  currentModelMetadata: AgentSessionModelOption | null
  record: NativeChatSessionOptionRecord
  /** The permission mode the host or launch last stated; null shows no picker. */
  permissionMode: string | null
  pendingId: string | null
}

/** With `seedCatalog`, the state holds the static seed from the first frame, but the picker shows
 *  the quiet placeholder until the host answers; every later source only upgrades it. */
export function createStructuredAgentSessionOptionState(
  agent = 'codex',
  seedCatalog?: AgentSessionOptionCatalog | null
): StructuredAgentSessionOptionState {
  return {
    catalog: seedCatalog ?? null,
    catalogSource: seedCatalog ? 'seed' : null,
    currentModelMetadata: null,
    record: createNativeChatSessionOptionRecord(agent),
    permissionMode: null,
    pendingId: null
  }
}

/** Only an unsupported surface permits the static compatibility menu. */
export function settleStructuredAgentSessionBuiltinCatalog(
  state: StructuredAgentSessionOptionState,
  error?: unknown
): StructuredAgentSessionOptionState {
  const oldMobileSurface =
    hasRuntimeRpcErrorCode(error, 'forbidden') &&
    error instanceof Error &&
    error.message.includes("Method 'agentSession.modelCatalog' is not available to mobile clients")
  return state.catalogSource === 'seed' &&
    (hasRuntimeRpcErrorCode(error, 'method_not_found') || oldMobileSurface)
    ? { ...state, catalogSource: 'builtin' }
    : state
}

/** A restarted child inherits intent, never the previous child's menu or confirmation. */
export function resetStructuredAgentSessionCurrentOptions(
  state: StructuredAgentSessionOptionState
): StructuredAgentSessionOptionState {
  const record = cloneNativeChatSessionOptionRecord(state.record)
  if (record.model?.source === 'reported') {
    record.model.source = 'dispatched'
  }
  for (const values of Object.values(record.valuesByModel)) {
    for (const tracked of Object.values(values)) {
      if (tracked.source === 'reported') {
        tracked.source = 'dispatched'
      }
    }
  }
  return { ...state, record, currentModelMetadata: null, pendingId: null }
}

/**
 * Applies the host's stored model catalog: models only, no current selection
 * and no record writes, so nothing here reads as a committed value — the pick
 * stays provisional until a live options result confirms it. Inventory refresh
 * remains independent of the current values a live answer reports.
 */
export function applyStructuredAgentSessionModelCatalog(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  catalog: AgentSessionModelCatalogResult,
  options: { newLaunch: boolean }
): StructuredAgentSessionOptionState {
  const independent = state.record.agent === 'claude' || state.record.agent === 'codex'
  // An unmigrated child's whole live configuration supplies its controls.
  if (!independent && state.catalogSource === 'live') {
    return state
  }
  const models =
    catalog.origin === 'unknown'
      ? []
      : catalog.models.map((model) =>
          discoveredModel(model, catalog.fastModeSupport?.supported === true)
        )
  if (catalog.origin === 'unknown' || models.length === 0) {
    return state
  }
  // The host says whether its listed default is what this launch runs; an older host never says,
  // so the client's own knowledge of the agent stands in. A reopened chat may keep its own model.
  const namesDefault =
    options.newLaunch &&
    (catalog.listingNamesConfiguredModel ?? seed.hostListingNamesConfiguredModel === true)
  return {
    ...state,
    // `isDefault` came from a real listing, so a launch's CLI default is nameable —
    // as a provisional `default`-source value, never a confirmed one.
    catalog: {
      ...seed,
      models,
      ...(namesDefault ? { defaultModelIsCliDefault: true } : {})
    },
    catalogSource: 'host'
  }
}

export function applyStructuredAgentSessionOptions(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult
): StructuredAgentSessionOptionState {
  if (result.current.effort === undefined) {
    clearTrackedSessionOption(
      state.record,
      result.current.model ??
        (typeof state.record.model?.value === 'string' ? state.record.model.value : null),
      'effort'
    )
  }
  if (result.current.fastMode === undefined) {
    clearTrackedSessionOption(state.record, result.current.model ?? null, 'fastMode')
  }
  if (result.current.serviceTier === undefined) {
    clearTrackedSessionOption(state.record, result.current.model ?? null, 'serviceTier')
  }
  applyNativeChatReportedSessionOptions(
    state.record,
    {
      ...(result.current.model ? { model: result.current.model } : {}),
      ...(result.current.effort ? { effort: result.current.effort } : {}),
      ...(result.current.fastMode !== undefined ? { fastMode: result.current.fastMode } : {}),
      ...(result.current.serviceTier ? { serviceTier: result.current.serviceTier } : {})
    },
    result.current.confirmed ?? []
  )
  const independent = state.record.agent === 'claude' || state.record.agent === 'codex'
  const currentRow = independent
    ? result.models.find((row) => row.id === result.current.model)
    : null
  const currentModelMetadata = currentRow
    ? {
        ...currentRow,
        ...(currentRow.effortsKnown === false ? { efforts: [], defaultEffort: undefined } : {}),
        supportsFastMode:
          currentRow.supportsFastMode === true && result.fastModeSupport?.supported === true
      }
    : null
  // Keep current metadata out of retained inventory, even before the separate discovery read lands.
  const inventoryResult = independent
    ? {
        ...result,
        models: result.models.map((row) =>
          row.id === result.current.model
            ? {
                ...row,
                efforts: [],
                defaultEffort: undefined,
                supportsFastMode: undefined,
                serviceTiers: undefined
              }
            : row
        )
      }
    : result
  return {
    ...state,
    currentModelMetadata,
    ...((!independent || (state.catalogSource !== 'host' && result.models.length > 0)) &&
    result.listedModelIds?.length !== 0
      ? {
          catalog: structuredAgentSessionOptionCatalog(seed, inventoryResult),
          catalogSource: 'live' as const
        }
      : result.current.model &&
          (state.catalogSource === 'seed' || state.catalogSource === 'builtin')
        ? { catalog: { ...seed, models: [] }, catalogSource: 'live' as const }
        : {}),
    permissionMode: result.current.permissionMode ?? null
  }
}

export function canSetStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: SessionOptionValue
): boolean {
  const descriptor = structuredAgentSessionOptionSnapshot(state).find((entry) => entry.id === id)
  return Boolean(
    state.catalog &&
    descriptor?.settable === true &&
    state.pendingId !== id &&
    ((typeof value === 'string' &&
      descriptor?.kind.type === 'select' &&
      descriptor.kind.choices.some((choice) => choice.value === value)) ||
      (typeof value === 'boolean' && descriptor?.kind.type === 'boolean'))
  )
}

export function commitStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: string
): StructuredAgentSessionOptionState {
  if (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
    return { ...state, permissionMode: value, pendingId: null }
  }
  if (!state.catalog) {
    return state
  }
  const effectiveModel = resolveEffectiveNativeChatModelId(
    state.catalog,
    state.catalog.models,
    state.record
  )
  const decoded = decodeStructuredAgentSessionOptionValue(id, value)
  if (decoded === null) {
    return { ...state, pendingId: null }
  }
  const effort =
    id === 'model' ? getTrackedSessionOption(state.record, effectiveModel, 'effort') : undefined
  setTrackedSessionOption(state.record, id, decoded, 'dispatched', effectiveModel)
  // The host saves effort for the conversation, including across model picks.
  if (effort) {
    setTrackedSessionOption(state.record, 'effort', effort.value, 'dispatched')
  }
  return {
    ...state,
    ...(id === 'model' && state.currentModelMetadata?.id !== value
      ? { currentModelMetadata: null }
      : {}),
    pendingId: null
  }
}

export function commitStructuredAgentSessionOptionValues(
  state: StructuredAgentSessionOptionState,
  values: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  let next = state
  for (const id of STRUCTURED_LAUNCH_OPTION_IDS) {
    const value = values[id]
    if (value !== undefined) {
      next = commitStructuredAgentSessionOption(next, id, value)
    }
  }
  return next
}

export type StructuredSessionOptionPick = {
  modelId: string
  optionId: string
  value: SessionOptionValue
}

/**
 * The picks a mutation must remember so the next launch starts where the user left off.
 * Keyed off the same ids the launch seed reads back, so a pick this surface cannot
 * re-seed is never written.
 *
 * Model and effort travel as a pair: a launch resolves a stored effort only under a
 * stored model, so an effort-only pick adopts the model it was chosen against. Values
 * come from what the provider committed, not what was requested — it reconciles an
 * effort the newly selected model cannot run before reporting back.
 *
 * `state` may still be pre-commit: a changed model arrives in `committed`, and an
 * unchanged one is already what the record tracks, so neither reading depends on the
 * commit having landed.
 */
export function structuredAgentSessionOptionPicks(
  state: StructuredAgentSessionOptionState,
  committed: Readonly<Record<string, string>>
): StructuredSessionOptionPick[] {
  if (!state.catalog) {
    return []
  }
  const committedModel = committed.model
  const modelId =
    typeof committedModel === 'string' && committedModel.trim()
      ? committedModel
      : resolveEffectiveNativeChatModelId(state.catalog, state.catalog.models, state.record)
  if (!modelId) {
    return []
  }
  return STRUCTURED_LAUNCH_SEED_OPTION_IDS.flatMap((optionId) => {
    const value = committed[optionId]
    if (value === undefined) {
      return []
    }
    const decoded = decodeStructuredAgentSessionOptionValue(optionId, value)
    return decoded === null ||
      (typeof decoded === 'string' && !decoded.trim()) ||
      encodeStructuredAgentSessionOptionValue(optionId, decoded) === null
      ? []
      : [{ modelId, optionId, value: decoded }]
  })
}
