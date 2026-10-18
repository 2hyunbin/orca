import type { AgentSessionUnavailable } from '../../../shared/agent-session-availability'
import type {
  AgentSessionFastModeSupport,
  AgentSessionModelCatalogResult,
  AgentSessionModelOption
} from '../../../shared/agent-session-wire'

/** `discovery`: an account-level listing that names the configured default and owns freshness.
 *  `live`: what a running session listed — which models exist and their efforts, nothing more. */
export type AgentModelCatalogSource = 'discovery' | 'live'

/** One successful listing, as any lister hands it to the store. */
export type AgentModelCatalogSuccess = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  origin: 'live-session' | 'probe'
  complete?: boolean
  configured?: { model?: string; effort?: string }
  advisory?: true
  /** A row only this session's launch added (its own `--model`): kept only once the account's
   *  catalog already lists that model. */
  launchOnlyModelId?: string
  /** A probe that listed models but also found no chat can start (a signed-out Codex): both kept. */
  unavailable?: AgentSessionUnavailable
}

/** One listing as the store keeps it. */
export type AgentModelCatalogListing = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  origin: 'live-session' | 'probe'
  at: number
  complete: boolean
  configured?: { model?: string; effort?: string; at?: number }
}

/** What a running session listed, as its adapter hands it to the host. Kept here, apart from the
 *  store, so the session wire types don't pull the store's Node-only persistence into clients. */
export type AgentModelCatalogLiveListing = {
  complete?: boolean
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  /** A row only this session's launch added (its own `--model`): kept only once the account's
   *  catalog already lists that model. */
  launchOnlyModelId?: string
  /** What the agent's own config resolution picked for a session launched with no model pick:
   *  the configured default for that session's config scope. Null when that resolution names no
   *  listed model, so a saved default is stale; absent when this session can't say. */
  configuredDefault?: AgentModelCatalogConfiguredChoice | null
}

/** A configured model as one session resolved it. `effort` is null when the config sends none
 *  and absent when the session picked its own, which says nothing about the config. */
export type AgentModelCatalogConfiguredChoice = {
  modelId: string
  /** Other listed rows that run the same model, and so the same effort. */
  sameModelIds?: string[]
  effort?: string | null
}

export function agentModelCatalogSessionObservation(
  listing: AgentModelCatalogLiveListing
): AgentModelCatalogSuccess {
  return {
    models: listing.models,
    origin: 'live-session',
    complete: false,
    ...(listing.fastModeSupport ? { fastModeSupport: listing.fastModeSupport } : {})
  }
}

/** What a session that resolves its agent's own config reports as that scope's configured default:
 *  only a new session that restored no model pick and was sent none runs it. Undefined when the
 *  session can't say (it listed or runs no model); null when it runs a model it didn't list. */
export function unpickedSessionConfiguredChoice(session: {
  resolvesConfig: boolean
  picked: ReadonlySet<string>
  models: readonly { id: string }[]
  current: { model?: string; effort?: string }
}): AgentModelCatalogConfiguredChoice | null | undefined {
  const { models, current } = session
  // An empty listing (a signed-out agent) is doubt, not a catalog.
  if (
    !session.resolvesConfig ||
    session.picked.has('model') ||
    !current.model ||
    models.length === 0
  ) {
    return undefined
  }
  if (!models.some((model) => model.id === current.model)) {
    return null
  }
  return {
    modelId: current.model,
    // An effort this session picked is its own and says nothing of the config's.
    ...(session.picked.has('effort') ? {} : { effort: current.effort ?? null })
  }
}

/** A live options answer whose model rows are the account's listing as the child reported it,
 *  with what its no-pick launch resolved when the session can say. */
export function withLiveCatalogListing<
  T extends Pick<AgentModelCatalogLiveListing, 'models' | 'fastModeSupport'>
>(
  options: T,
  configuredDefault?: AgentModelCatalogConfiguredChoice | null
): T & { catalogListing: AgentModelCatalogLiveListing } {
  return {
    ...options,
    catalogListing: {
      models: options.models,
      ...(options.fastModeSupport ? { fastModeSupport: options.fastModeSupport } : {}),
      ...(configuredDefault !== undefined ? { configuredDefault } : {})
    }
  }
}

export type AgentModelCatalogEntry = {
  agent: string
  fingerprint: string
  observation: AgentModelCatalogListing
  source: 'discovery' | 'probe-advisory' | 'session-advisory'
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  origin: 'live-session' | 'probe'
  fetchedAt: number
}

export function agentModelCatalogEntry(
  agent: string,
  fingerprint: string,
  observation: AgentModelCatalogListing,
  source: AgentModelCatalogEntry['source']
): AgentModelCatalogEntry {
  return {
    agent,
    fingerprint,
    observation,
    source,
    models: observation.models,
    ...(observation.fastModeSupport ? { fastModeSupport: observation.fastModeSupport } : {}),
    origin: observation.origin,
    fetchedAt: observation.at
  }
}

export function agentModelCatalogResultFromEntry(
  entry: AgentModelCatalogEntry,
  namesDefault: boolean,
  listingNamesConfiguredModel: boolean
): Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }> {
  const configured = entry.observation.configured
  const configuredRow = configured?.model
    ? entry.models.find(
        (row) => row.id === configured.model || row.resolvedModel === configured.model
      )
    : undefined
  return {
    origin: entry.origin,
    models: entry.models.map((row) => ({
      ...row,
      isDefault: namesDefault && (configured?.model ? row === configuredRow : row.isDefault),
      ...(configured?.effort &&
      (row === configuredRow || (!configured?.model && row.isDefault)) &&
      row.efforts.some((effort) => effort.value === configured.effort)
        ? { defaultEffort: configured.effort }
        : {})
    })),
    ...(entry.fastModeSupport ? { fastModeSupport: entry.fastModeSupport } : {}),
    fetchedAt: entry.fetchedAt,
    listingNamesConfiguredModel:
      namesDefault && (listingNamesConfiguredModel || configuredRow !== undefined)
  }
}

/** Legacy launch-only filtering; this heuristic is not modern membership proof. */
export function retainedAgentModelCatalogModels(
  previous: Pick<AgentModelCatalogEntry, 'models'> | null | undefined,
  listing: AgentModelCatalogLiveListing
): AgentSessionModelOption[] {
  const launchOnly = listing.launchOnlyModelId
  return launchOnly !== undefined && !previous?.models.some((model) => model.id === launchOnly)
    ? listing.models.filter((model) => model.id !== launchOnly)
    : listing.models
}

export function agentModelCatalogEntryWithSuccess(
  previous: AgentModelCatalogEntry | undefined,
  identity: { agent: string; fingerprint: string },
  success: AgentModelCatalogSuccess,
  source: AgentModelCatalogSource,
  at: number
): AgentModelCatalogEntry | null {
  if (success.models.length === 0) {
    return null
  }
  const provenance =
    source === 'live' ? 'session-advisory' : success.advisory ? 'probe-advisory' : 'discovery'
  const independent = identity.agent === 'claude' || identity.agent === 'codex'
  if (
    independent &&
    previous &&
    ((previous.source === 'discovery' && provenance !== 'discovery') ||
      (previous.source === 'session-advisory' && provenance === 'probe-advisory'))
  ) {
    return previous
  }
  const configured =
    success.configured ?? (!independent ? previous?.observation.configured : undefined)
  return agentModelCatalogEntry(
    identity.agent,
    identity.fingerprint,
    {
      models: success.models.map((model) => {
        const older = !independent ? previous?.models.find((row) => row.id === model.id) : undefined
        const retainsEffort =
          source === 'discovery' &&
          model.efforts.length > 0 &&
          configured?.model === model.id &&
          !model.efforts.some((choice) => choice.value === configured.effort) &&
          older?.efforts.some((choice) => choice.value === configured.effort)
        return older
          ? {
              ...older,
              ...model,
              effortsKnown: model.effortsKnown,
              ...(model.effortsKnown === false || retainsEffort
                ? {
                    efforts: older.efforts,
                    effortsKnown: older.effortsKnown,
                    defaultEffort: older.defaultEffort
                  }
                : {})
            }
          : { ...model }
      }),
      origin: success.origin,
      at,
      complete: success.complete !== false,
      ...(configured ? { configured } : {}),
      ...((success.fastModeSupport ?? (!independent ? previous?.fastModeSupport : undefined))
        ? { fastModeSupport: success.fastModeSupport ?? previous?.fastModeSupport }
        : {})
    },
    provenance
  )
}

/** A qualified startup changes configuration facts; menu reads leave their clock alone. */
export function entryWithConfiguredDefault(
  entry: AgentModelCatalogEntry,
  choice: AgentModelCatalogConfiguredChoice | null,
  at: number
): AgentModelCatalogEntry | null {
  const previous = entry.observation.configured
  const effort =
    choice?.effort === undefined
      ? previous?.model === choice?.modelId
        ? previous?.effort
        : undefined
      : (choice.effort ?? undefined)
  const configured = choice ? { model: choice.modelId, ...(effort ? { effort } : {}) } : undefined
  const { at: _at, ...facts } = previous ?? {}
  if (JSON.stringify(configured ?? {}) === JSON.stringify(facts)) {
    return null
  }
  return agentModelCatalogEntry(
    entry.agent,
    entry.fingerprint,
    {
      ...entry.observation,
      configured: configured ? { ...configured, at } : undefined
    },
    entry.source
  )
}

export function agentModelCatalogListingKey(entry: AgentModelCatalogEntry): string {
  const { at: _at, ...observation } = entry.observation
  return JSON.stringify([entry.source, observation])
}
