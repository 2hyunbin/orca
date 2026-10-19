// A pick made at rest is answered with what the next start runs; the record keeps the pick itself.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import { savedEffectiveServiceTier } from '../../../shared/structured-agent-session-effective-tier'
import type { AgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'

/** Whether a saved effort or Fast still runs under a newly picked model's listed row. The saved
 *  tier is kept: it runs as the row's effective tier. */
function offeredUnder(row: AgentSessionModelOption, key: string, value: string): boolean {
  if (key === 'effort') {
    return row.efforts.some((entry) => entry.value === value)
  }
  return key !== 'fastMode' || value !== 'true' || row.supportsFastMode !== false
}

/** The options a pick saves and the answer naming them, with the tier the chat's model runs. A
 *  model pick drops a saved effort or Fast its listed row doesn't offer, which every later send
 *  would carry and the agent refuse; an unlisted model keeps them. */
export async function structuredAgentSessionPickOptions(
  deps: { modelCatalog?: Pick<AgentModelCatalogService, 'read'> },
  record: Pick<AgentSessionRecord, 'provider'>,
  sessionId: string,
  pick: { key: string; value: string },
  saved: () => Readonly<Record<string, string>> | undefined
): Promise<{ options: Record<string, string>; replied: Record<string, string> }> {
  if (pick.key !== 'model' && !saved()?.serviceTier) {
    const options = { ...saved(), [pick.key]: pick.value }
    return { options, replied: options }
  }
  const listing = await deps.modelCatalog
    ?.read({ agent: record.provider, sessionId, savedOnly: true })
    .catch(() => null)
  // Read after the wait, so a value saved meanwhile is kept.
  const picked = { ...saved(), [pick.key]: pick.value }
  const models = listing && listing.origin !== 'unknown' ? listing.models : []
  const row = pick.key === 'model' ? models.find((entry) => entry.id === pick.value) : undefined
  const options = row
    ? Object.fromEntries(
        Object.entries(picked).filter(([key, value]) => offeredUnder(row, key, value))
      )
    : picked
  const serviceTier = savedEffectiveServiceTier(options, models) ?? options.serviceTier
  return { options, replied: serviceTier ? { ...options, serviceTier } : options }
}
