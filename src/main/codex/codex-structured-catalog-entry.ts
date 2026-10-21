import { structuredAgentSessionCapabilityView } from '../native-chat/agent-session-wire/structured-agent-session-option-models'
import type { AgentModelCatalogEntry } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { CodexSession, CodexSessionCatalogAccess } from './codex-structured-session-state'
import type { CodexModelCatalogListing } from './codex-structured-model-catalog'

export function listingFromEntry(entry: AgentModelCatalogEntry): CodexModelCatalogListing {
  return {
    models: entry.models.map((model) => ({ ...model })),
    complete: entry.discovered?.complete === true,
    ...(entry.configured
      ? {
          configured: {
            model: entry.configured.modelId,
            ...(entry.configured.effort ? { effort: entry.configured.effort } : {})
          }
        }
      : {})
  }
}

/** Acquisition uses known choices only; picker reads discover new choices later. */
export function codexAcquireCatalogListing(
  catalogAccess: CodexSessionCatalogAccess | undefined,
  verifiedOnly = false
): CodexModelCatalogListing | null {
  const entry = catalogAccess?.read
    ? catalogAccess.read(verifiedOnly)
    : catalogAccess?.store.get(catalogAccess.fingerprint)
  if (verifiedOnly && entry && !catalogAccess?.read && !catalogAccess?.store.verified(entry)) {
    return null
  }
  return entry ? listingFromEntry(entry) : null
}

/** Held inventory describes alternatives; only the eligible child can override current controls. */
export type CodexCapabilitySession = Pick<CodexSession, 'catalogAccess' | 'options'> &
  Partial<
    Pick<
      CodexSession,
      | 'fence'
      | 'acquisitionGeneration'
      | 'ended'
      | 'exitObservedAt'
      | 'currentModelCapabilities'
      | 'reportedOptions'
    >
  > & {
    connection?: Pick<CodexSession['connection'], 'request'> &
      Partial<Pick<CodexSession['connection'], 'closed'>>
  }

export function codexCurrentModelObservation(
  session: CodexCapabilitySession,
  model = session.options.get('model') ?? session.reportedOptions?.model
) {
  const fact = session.currentModelCapabilities
  return fact &&
    fact.model === model &&
    fact.connection === session.connection &&
    fact.fence === session.fence &&
    fact.generation === session.acquisitionGeneration &&
    !session.ended &&
    session.exitObservedAt === undefined &&
    !session.connection?.closed
    ? fact.observation
    : undefined
}

export function codexSessionCapabilities(
  session: CodexCapabilitySession,
  model = session.options.get('model') ?? session.reportedOptions?.model
): ReturnType<typeof structuredAgentSessionCapabilityView> {
  const listing = codexAcquireCatalogListing(session.catalogAccess) ?? { models: [] }
  return structuredAgentSessionCapabilityView(
    listing,
    model,
    codexCurrentModelObservation(session, model)
  )
}
