import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { agentModelCatalogResultFromEntry } from './agent-model-catalog-entry'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'

export type AgentModelCatalogBinding = {
  identity: string
  params: AgentModelCatalogReadParams
  workspaceId?: string
  current: () => boolean
  cancel: () => void
  fingerprint: string
  base: string
  exact: boolean
  folder?: string
  cwd?: string
  workspacePath?: string | null
  keepDefault: boolean
  projecting?: Promise<void>
}

export function agentModelCatalogRequestKey(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams
): string {
  const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
  const inWorkspace =
    params.inSessionWorkspace ||
    (record &&
      !params.workspace &&
      params.workspacePath === undefined &&
      independentAgentModelCatalog(params.agent) &&
      !params.legacy)
  return JSON.stringify({
    agent: params.agent,
    account: record && [
      record.provider,
      record.accountHome,
      record.location.executionHostId,
      record.location.wslDistro,
      deps.drivesRecord(record)
    ],
    selector: params.workspace?.selector,
    workspacePath: params.workspacePath,
    inSessionWorkspace:
      inWorkspace && record ? [record.location.workspaceId, record.launchDirectory] : undefined,
    legacy: params.legacy
  })
}

export function agentModelCatalogScopeIdentity(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams
): string {
  return JSON.stringify([
    deps.store.retirementRevision(params.agent),
    params.workspace?.identity(),
    agentModelCatalogRequestKey(deps, params)
  ])
}

export function agentModelCatalogMemoryBinding(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams,
  bindings: ReadonlyMap<string, AgentModelCatalogBinding>,
  capture: (params: AgentModelCatalogReadParams) => string
): AgentModelCatalogBinding | undefined {
  const held = bindings.get(agentModelCatalogRequestKey(deps, params))
  if (held?.current() && held.identity === capture(params)) {
    return held
  }
  const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
  if (!record || record.provider !== params.agent || !deps.drivesRecord(record)) {
    return
  }
  // Pinned native account and cwd can reuse a scope another caller already proved.
  const cwd = params.workspace
    ? undefined
    : params.workspacePath === undefined
      ? agentSessionPinnedLaunchDirectory(record)
      : params.workspacePath
  if (cwd && record.location.executionHostId === 'local' && record.location.wslDistro === null) {
    for (const bound of bindings.values()) {
      if (
        bound.params.agent === params.agent &&
        !!bound.params.legacy === !!params.legacy &&
        (bound.cwd ?? bound.folder ?? bound.workspacePath) === cwd &&
        (!bound.params.sessionId ||
          deps.getRecord(bound.params.sessionId)?.location.executionHostId === 'local') &&
        bound.base === agentModelCatalogFingerprintForRecord(record, bound.folder) &&
        bound.current() &&
        bound.identity === capture(bound.params)
      ) {
        return bound
      }
    }
  }
  if (
    deps.listsInChatFolder?.has(params.agent) ||
    params.workspace ||
    params.inSessionWorkspace ||
    (params.workspacePath !== null && independentAgentModelCatalog(params.agent))
  ) {
    return
  }
  const fingerprint = agentModelCatalogFingerprintForRecord(record)
  return {
    identity: capture(params),
    params,
    current: () => true,
    cancel: () => {},
    fingerprint,
    base: fingerprint,
    exact: false,
    keepDefault: params.workspacePath === undefined || params.legacyOptionsDisplay === true
  }
}

export function projectAgentModelCatalogSnapshot(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams,
  bound: AgentModelCatalogBinding,
  resolving: boolean
): AgentSessionModelCatalogResult {
  const listed = deps.store.observation(bound.fingerprint)
  const independent = independentAgentModelCatalog(params.agent)
  if (
    params.verifiedOnly &&
    (!listed || (independent && (!bound.exact || !deps.store.verified(listed))))
  ) {
    return { origin: 'unknown' }
  }
  const display =
    listed ?? (bound.exact && !params.verifiedOnly ? deps.store.observation(bound.base) : null)
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
    (deps.store.isListing(bound.fingerprint) ||
      (resolving && deps.store.probeDue(bound.fingerprint))) &&
    (independent || !listed)
      ? { listingInProgress: true as const }
      : {}),
    ...(deps.store.failure(bound.fingerprint)?.unavailable
      ? { unavailable: deps.store.failure(bound.fingerprint)?.unavailable }
      : {})
  }
}

export function retireAgentModelCatalogRequests(
  deps: AgentModelCatalogServiceDeps,
  bindings: Map<string, AgentModelCatalogBinding>,
  claims: Map<string, { params: AgentModelCatalogReadParams; controller: AbortController }>,
  workspaceId?: string
): void {
  for (const [key, claim] of claims) {
    if (
      workspaceId === undefined ||
      !claim.params.sessionId ||
      deps.getRecord(claim.params.sessionId)?.location.workspaceId === workspaceId
    ) {
      claim.controller.abort()
      claims.delete(key)
    }
  }
  for (const [key, bound] of bindings) {
    if (workspaceId === undefined || bound.workspaceId === workspaceId || !bound.workspaceId) {
      bound.cancel()
      bindings.delete(key)
    }
  }
}
