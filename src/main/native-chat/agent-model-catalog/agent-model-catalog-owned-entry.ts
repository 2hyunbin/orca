import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'

export function ownedAgentModelCatalogModels(
  models: AgentSessionModelOption[],
  previous?: AgentSessionModelOption[]
): AgentSessionModelOption[] {
  return previous && JSON.stringify(previous) === JSON.stringify(models)
    ? previous
    : structuredClone(models)
}

export function readAgentModelCatalogEntry(
  entries: Map<string, AgentModelCatalogEntry>,
  fingerprint: string
): AgentModelCatalogEntry | null {
  const entry = entries.get(fingerprint)
  if (entry) {
    entries.delete(fingerprint)
    entries.set(fingerprint, entry)
  }
  return entry ?? null
}
