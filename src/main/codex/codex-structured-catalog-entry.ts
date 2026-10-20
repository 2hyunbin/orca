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

export function codexSessionCapabilities(
  session: CodexCapabilitySession,
  model = session.options.get('model') ?? session.reportedOptions?.model
): CodexModelCatalogListing {
  const listing = codexAcquireCatalogListing(session.catalogAccess) ?? { models: [] }
  const fact = session.currentModelCapabilities
  const row =
    fact &&
    fact.model === model &&
    fact.connection === session.connection &&
    fact.fence === session.fence &&
    fact.generation === session.acquisitionGeneration &&
    !session.ended &&
    session.exitObservedAt === undefined &&
    !session.connection?.closed
      ? fact.row
      : undefined
  if (!row) {
    return listing
  }
  const models = listing.models.map((entry) =>
    entry.id === row.id
      ? {
          ...entry,
          ...(row.effortsKnown !== false
            ? {
                efforts: row.efforts,
                effortsKnown: row.effortsKnown,
                defaultEffort: row.defaultEffort
              }
            : {}),
          serviceTiers: row.serviceTiers,
          supportsFastMode: row.supportsFastMode
        }
      : entry
  )
  if (!models.some((entry) => entry.id === row.id)) {
    models.push({ ...row, isDefault: false })
  }
  return {
    ...listing,
    models,
    listedServiceTiers: [
      ...listing.models.flatMap((entry) => entry.serviceTiers?.map((tier) => tier.value) ?? []),
      ...(row.serviceTiers?.map((tier) => tier.value) ?? [])
    ]
  }
}
