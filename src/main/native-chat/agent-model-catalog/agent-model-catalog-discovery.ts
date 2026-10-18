import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type {
  AgentModelCatalogEntry,
  AgentModelCatalogListing,
  AgentModelCatalogSource,
  AgentModelCatalogSuccess
} from './agent-model-catalog-entry'

/** Lists an agent's models without a session, under the account a launch would pin. `signal`
 *  stops the listing and its child once the host that asked is going away. */
export type AgentModelCatalogResolvedProbe = {
  identity: unknown
  run: (signal?: AbortSignal) => Promise<AgentModelCatalogSuccess>
}

export type AgentModelCatalogProbe = ((
  accountHome: AgentSessionAccountHome,
  options?: { signal?: AbortSignal; cwd?: string }
) => Promise<AgentModelCatalogSuccess>) & {
  resolveLegacy?: (home: AgentSessionAccountHome) => Promise<AgentModelCatalogResolvedProbe>
  resolve?: (
    accountHome: AgentSessionAccountHome,
    cwd: string,
    saved?: Readonly<Record<string, string>>
  ) => Promise<AgentModelCatalogResolvedProbe>
}

/**
 * What every agent registration must say about its models: a probe that lists them without
 * starting a session, or that it has none. Refresh, keying, persistence and publication are the
 * catalog service's, never the agent's. An agent with no probe shows the provider-default
 * placeholder until a live session reports.
 */
export type AgentModelCatalogDiscovery =
  | {
      kind: 'probe'
      probe: AgentModelCatalogProbe
      /** The listing marks the model the account is configured to run as its default, so a new
       *  chat launches the listed default. False where the agent's own settings may pick another. */
      listingNamesConfiguredModel: boolean
    }
  | { kind: 'unavailable'; reason: string }

export function discoveryEntry(
  agent: string,
  fingerprint: string,
  observation: AgentModelCatalogListing,
  source: NonNullable<AgentModelCatalogEntry['source']>
): AgentModelCatalogEntry {
  return {
    agent,
    fingerprint,
    observation,
    source,
    discovered: null,
    live: null,
    configured: null,
    models: observation.models,
    ...(observation.fastModeSupport ? { fastModeSupport: observation.fastModeSupport } : {}),
    origin: observation.origin,
    fetchedAt: observation.at
  }
}

export function discoveryEntryWithSuccess(
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
  if (
    previous &&
    ((previous.source === 'discovery' && provenance !== 'discovery') ||
      (previous.source === 'session-advisory' && provenance === 'probe-advisory'))
  ) {
    return previous
  }
  return discoveryEntry(
    identity.agent,
    identity.fingerprint,
    {
      models: success.models.map((model) => ({ ...model })),
      origin: success.origin,
      at,
      complete: success.complete !== false,
      ...(success.configured ? { configured: success.configured } : {}),
      ...(success.fastModeSupport ? { fastModeSupport: success.fastModeSupport } : {})
    },
    provenance
  )
}

export function discoveryResult(
  entry: AgentModelCatalogEntry,
  namesDefault: boolean,
  listingNamesConfiguredModel: boolean
): Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }> {
  const canNameDefault = namesDefault && (entry.agent === 'claude' || entry.agent === 'codex')
  const configured = entry.observation?.configured
  const configuredRow = configured?.model
    ? entry.models.find(
        (row) => row.id === configured.model || row.resolvedModel === configured.model
      )
    : undefined
  return {
    origin: entry.origin,
    models: entry.models.map((row) => ({
      ...row,
      isDefault: canNameDefault && (configured?.model ? row === configuredRow : row.isDefault),
      ...(configured?.effort &&
      (row === configuredRow || (!configured?.model && row.isDefault)) &&
      row.efforts.some((effort) => effort.value === configured.effort)
        ? { defaultEffort: configured.effort }
        : {})
    })),
    ...(entry.fastModeSupport ? { fastModeSupport: entry.fastModeSupport } : {}),
    fetchedAt: entry.fetchedAt,
    listingNamesConfiguredModel:
      canNameDefault && (listingNamesConfiguredModel || configuredRow !== undefined)
  }
}

export function rememberDiscoveryScope(
  keys: Map<string, string>,
  sessionId: string,
  fingerprint: string
): void {
  if (keys.size >= 256 && !keys.has(sessionId)) {
    const oldest = keys.keys().next().value
    if (oldest !== undefined) {
      keys.delete(oldest)
    }
  }
  keys.set(sessionId, fingerprint)
}
