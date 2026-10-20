import type { AgentModelCatalogEntry } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { CodexSessionCatalogAccess } from './codex-structured-session-state'
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
