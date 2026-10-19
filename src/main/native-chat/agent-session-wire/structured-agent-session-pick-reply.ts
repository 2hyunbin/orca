// A pick made at rest is answered with what the next start runs; the record keeps the pick itself.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { savedEffectiveServiceTier } from '../../../shared/structured-agent-session-effective-tier'
import type { AgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'

/** The saved options with the tier the chat's model runs, as the at-rest answer names it. */
export async function restingPickReplyOptions(
  deps: { modelCatalog?: Pick<AgentModelCatalogService, 'read'> },
  record: Pick<AgentSessionRecord, 'provider'>,
  sessionId: string,
  options: Record<string, string>
): Promise<Record<string, string>> {
  if (!options.serviceTier) {
    return options
  }
  const listing = await deps.modelCatalog
    ?.read({ agent: record.provider, sessionId, savedOnly: true })
    .catch(() => null)
  const models = listing && listing.origin !== 'unknown' ? listing.models : []
  const serviceTier = savedEffectiveServiceTier(options, models) ?? options.serviceTier
  return { ...options, serviceTier }
}
