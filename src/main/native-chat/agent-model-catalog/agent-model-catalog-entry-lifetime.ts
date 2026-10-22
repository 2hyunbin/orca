import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'

export const AGENT_MODEL_CATALOG_FRESH_MS = 10 * 60_000

export function agentModelCatalogEntryIsStale(
  entry: AgentModelCatalogEntry,
  due: boolean,
  now: number
): boolean {
  return (
    due ||
    !entry.discovered ||
    (independentAgentModelCatalog(entry.agent) && entry.discovered.complete !== true) ||
    now - entry.discovered.at >=
      (independentAgentModelCatalog(entry.agent) ? 2 * 60_000 : AGENT_MODEL_CATALOG_FRESH_MS)
  )
}

export function pruneAgentModelCatalogPartialAttempts(
  attempts: Map<string, { agent: string; at: number }>,
  now: number
): void {
  for (const [key, attempt] of attempts) {
    if (now - attempt.at >= 2 * 60_000) {
      attempts.delete(key)
    }
  }
}

export function evictAgentModelCatalogEntries(
  entries: Map<string, AgentModelCatalogEntry>,
  dueEntries: Set<string>,
  partialAttempts: Map<string, { agent: string; at: number }>,
  cap: number
): void {
  for (const key of entries.keys()) {
    if (entries.size <= cap) {
      return
    }
    entries.delete(key)
    dueEntries.delete(key)
    partialAttempts.delete(key)
  }
}
