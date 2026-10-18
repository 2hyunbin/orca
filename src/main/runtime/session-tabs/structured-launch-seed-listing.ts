// A new Claude chat seeded from the remembered default starts on a model the host's finished
// listing names: a remembered model it no longer lists moves to the listing's default row, else
// its first, with the effort moved to the nearest level offered. Only seeding: a chat's own saved
// or running model is never replaced.

import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { finishedListingIds } from '../../../shared/structured-agent-session-options'
import type { AgentModelCatalogService } from '../../native-chat/agent-model-catalog/agent-model-catalog-service'

const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** `previous` if `supported` offers it, else the nearest offered level (the higher on a tie). */
export function nearestAgentEffort(
  previous: string,
  supported: readonly string[]
): string | undefined {
  const rank = (level: string): number => EFFORT_RANK.indexOf(level)
  const distance = (level: string): number => Math.abs(rank(level) - rank(previous))
  if (supported.includes(previous)) {
    return previous
  }
  if (rank(previous) === -1) {
    return undefined
  }
  return supported
    .filter((level) => rank(level) !== -1)
    .sort((a, b) => distance(a) - distance(b) || rank(b) - rank(a))[0]
}

export function structuredLaunchSeedOnListing(
  agent: string,
  seed: Readonly<Record<string, string>> | undefined,
  catalog: AgentSessionModelCatalogResult
): Readonly<Record<string, string>> | undefined {
  const listed = finishedListingIds(catalog)
  if (agent !== 'claude' || !seed?.model || !listed || listed.includes(seed.model)) {
    return seed
  }
  const rows = catalog.origin === 'unknown' ? [] : catalog.models
  const target = rows.find((row) => row.isDefault) ?? rows[0]
  if (!target) {
    return seed
  }
  const { effort: remembered, ...rest } = seed
  const effort = remembered
    ? nearestAgentEffort(
        remembered,
        target.efforts.map((choice) => choice.value)
      )
    : undefined
  return { ...rest, model: target.id, ...(effort ? { effort } : {}) }
}

/** The seed against the host's saved listing for the folder a new chat runs in; unread unless a
 *  Claude seed names a model, and an unreadable listing keeps the seed. */
export async function structuredLaunchSeedOnSavedListing(
  host: { deps: { modelCatalog?: Pick<AgentModelCatalogService, 'read'> } },
  agent: string,
  seed: Readonly<Record<string, string>> | undefined,
  workspacePath: () => Promise<string | null>
): Promise<Readonly<Record<string, string>> | undefined> {
  if (agent !== 'claude' || !seed?.model || !host.deps.modelCatalog) {
    return seed
  }
  const catalogs = host.deps.modelCatalog
  const catalog = await workspacePath()
    .catch(() => null)
    .then((path) => catalogs.read({ agent, workspacePath: path, savedOnly: true }))
    .catch(() => null)
  return catalog ? structuredLaunchSeedOnListing(agent, seed, catalog) : seed
}
