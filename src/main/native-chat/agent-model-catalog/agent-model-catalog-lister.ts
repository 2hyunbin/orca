import type { AgentModelCatalogProbe } from './agent-model-catalog-discovery'
import type { AgentModelCatalogStore } from './agent-model-catalog-store'

/** Who lists, by identity: a live session's per-spawn handle, or the session-less probe. */
export type AgentModelCatalogLister = AgentModelCatalogSessionAccess | AgentModelCatalogProbe

/** A live session's handle into the store, pinned at spawn to the account home
 *  THAT child launched under — an account switched afterwards must never
 *  receive or poison this session's listing. */
export type AgentModelCatalogSessionAccess = {
  store: AgentModelCatalogStore
  fingerprint: string
  accountHomePath: string
}
