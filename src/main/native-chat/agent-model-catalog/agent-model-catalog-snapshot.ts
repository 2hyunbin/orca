import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { agentModelCatalogResultFromEntry } from './agent-model-catalog-entry'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'

export type AgentModelCatalogBinding = {
  identity: string
  fingerprint: string
  base: string
  exact: boolean
  folder?: string
  workspacePath?: string | null
  keepDefault: boolean
  projecting?: Promise<void>
}

export function projectAgentModelCatalogSnapshot(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams,
  bound: AgentModelCatalogBinding,
  _resolving: boolean
): AgentSessionModelCatalogResult {
  const listed = deps.store.get(bound.fingerprint)
  const independent = independentAgentModelCatalog(params.agent)
  if (
    params.verifiedOnly &&
    (!listed || (independent && (!bound.exact || !deps.store.verified(listed))))
  ) {
    return { origin: 'unknown' }
  }
  const display =
    listed ?? (bound.exact && !params.verifiedOnly ? deps.store.get(bound.base) : null)
  const verified = bound.exact && listed !== null && deps.store.verified(listed)
  const result = display
    ? agentModelCatalogResultFromEntry(
        display,
        independent &&
          !params.legacyOptionsDisplay &&
          (!deps.store.verified(display) || (!bound.exact && !params.legacy))
          ? false
          : verified || bound.keepDefault,
        deps.listingNamesConfiguredModel?.has(params.agent) === true,
        !independent || verified
      )
    : null
  return {
    ...(result ?? { origin: 'unknown' }),
    ...(result?.listingNamesConfiguredModel &&
    deps.agentReadsProjectModelConfig?.(params.agent) === false
      ? { defaultHoldsInEveryWorkspace: true as const }
      : {}),
    ...(result && (bound.folder !== undefined || bound.exact)
      ? { modelsDifferByWorkspace: true as const }
      : {}),
    ...(!params.savedOnly &&
    !params.verifiedOnly &&
    deps.store.isListing(bound.fingerprint) &&
    (independent || !listed)
      ? { listingInProgress: true as const }
      : {}),
    ...(deps.store.failure(bound.fingerprint)?.unavailable
      ? { unavailable: deps.store.failure(bound.fingerprint)?.unavailable }
      : {})
  }
}
