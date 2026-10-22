import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogLiveListings } from './agent-model-catalog-live-listings'
import { scopedAgentModelCatalogLister } from './agent-model-catalog-lister'
import { prewarmAgentModelCatalog, newChatCatalogKey } from './agent-model-catalog-prewarm'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import {
  catalogFolder,
  sessionWorkspacePath,
  workspaceKeepsListedDefault
} from './agent-model-catalog-workspace'

import type {
  AgentModelCatalogServiceDeps,
  AgentModelCatalogService,
  AgentModelCatalogReadParams
} from './agent-model-catalog-service-contract'
export type { AgentModelCatalogServiceDeps, AgentModelCatalogService }
import { resolveAgentModelCatalogScope } from './agent-model-catalog-scope'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import { onAtRestCommandContextRetired } from '../agent-session-wire/at-rest-command-context'
import {
  projectAgentModelCatalogSnapshot,
  agentModelCatalogRequestKey,
  agentModelCatalogScopeIdentity,
  retireAgentModelCatalogRequests,
  agentModelCatalogMemoryBinding,
  type AgentModelCatalogBinding
} from './agent-model-catalog-snapshot'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'

export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  // One per host: stopping it ends every listing this service started.
  const lifetime = new AbortController()
  const admission = new PrioritySemaphore(2)

  type Claim = {
    identity: string
    controller: AbortController
    promise: Promise<void>
    ready: Promise<void>
    params: AgentModelCatalogReadParams
  }
  const bindings = new Map<string, AgentModelCatalogBinding>()
  const claims = new Map<string, Claim>()
  const requestKey = (params: AgentModelCatalogReadParams): string =>
    agentModelCatalogRequestKey(deps, params)
  const capture = (params: AgentModelCatalogReadParams): string =>
    agentModelCatalogScopeIdentity(deps, params)
  const retireContext = (workspaceId?: string, sources = true): void => {
    if (sources) {
      live.retireContext(workspaceId)
    }
    retireAgentModelCatalogRequests(deps, bindings, claims, workspaceId)
  }
  const live = createAgentModelCatalogLiveListings(deps, lifetime.signal)
  const unbindRetirement = onAtRestCommandContextRetired((workspaceId) =>
    retireContext(workspaceId, workspaceId !== undefined)
  )
  const memoryBinding = (params: AgentModelCatalogReadParams) =>
    agentModelCatalogMemoryBinding(deps, params, bindings, capture)
  const snapshot = (params: AgentModelCatalogReadParams): AgentSessionModelCatalogResult => {
    const bound = memoryBinding(params)
    const key = requestKey(params)
    if (lifetime.signal.aborted || !bound) {
      return {
        origin: 'unknown',
        ...(!params.savedOnly && claims.get(key)?.identity === capture(params)
          ? { listingInProgress: true as const }
          : {})
      }
    }
    return projectAgentModelCatalogSnapshot(deps, params, bound, claims.has(key))
  }

  const resolve = (params: AgentModelCatalogReadParams): Promise<void> => {
    if (lifetime.signal.aborted) {
      return Promise.resolve()
    }
    const bindingKey = requestKey(params)
    const key = params.savedOnly ? `${bindingKey}:saved` : bindingKey
    const identity = capture(params)
    const retirement = deps.store.retirementRevision(params.agent)
    const previous = claims.get(key)
    if (previous?.identity === identity) {
      return previous.promise
    }
    previous?.controller.abort()
    const controller = new AbortController()
    const ready = Promise.withResolvers<void>()
    const valid = (): boolean =>
      !controller.signal.aborted && !lifetime.signal.aborted && capture(params) === identity
    const current = (): boolean => valid() && claims.get(key)?.controller === controller
    const run = async (): Promise<void> => {
      const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
      const scoped =
        record && record.provider === params.agent && deps.drivesRecord(record) ? record : undefined
      if (record && !scoped) {
        return
      }
      const workspacePath = params.workspace
        ? await params.workspace.resolve().catch(() => null)
        : params.inSessionWorkspace
          ? record
            ? await sessionWorkspacePath(deps, record)
            : null
          : params.workspacePath
      const folder = await catalogFolder(deps, params.agent, workspacePath, scoped)
      let fingerprint: string
      // The account a probe lists under; null where this host cannot spawn one natively.
      let probeHome: AgentSessionAccountHome | null
      if (scoped) {
        fingerprint = agentModelCatalogFingerprintForRecord(scoped, folder)
        // Probes spawn natively; a WSL-pinned record has no host-side lister.
        probeHome =
          scoped.location.executionHostId === 'local' && scoped.location.wslDistro === null
            ? scoped.accountHome
            : null
      } else {
        const key = await newChatCatalogKey(deps, params.agent, folder)
        if (!key) {
          return
        }
        fingerprint = key.fingerprint
        probeHome = key.accountHome
      }
      const scope = await resolveAgentModelCatalogScope(
        deps,
        { ...params, workspacePath },
        scoped,
        fingerprint,
        probeHome
      )
      if (!scope) {
        return
      }
      const { base, exact, resolved, cwd } = scope
      fingerprint = scope.fingerprint
      if (!current()) {
        return
      }
      const bound: AgentModelCatalogBinding = {
        identity,
        params,
        current: () =>
          !controller.signal.aborted &&
          !lifetime.signal.aborted &&
          deps.store.retirementRevision(params.agent) === retirement,
        workspaceId: record?.location.workspaceId,
        cancel: () => controller.abort(),
        fingerprint,
        base,
        exact,
        folder,
        cwd,
        workspacePath,
        keepDefault:
          workspacePath === undefined ||
          (workspacePath === null && independentAgentModelCatalog(params.agent))
      }
      bindings.set(bindingKey, bound)
      while (bindings.size > 256) {
        const oldest = bindings.keys().next().value
        if (oldest !== undefined) {
          bindings.delete(oldest)
        }
      }
      const accountHomePath =
        probeHome && isLegacyAgentSessionAccountHome(probeHome) ? probeHome.path : null
      bound.projecting = workspaceKeepsListedDefault(
        deps,
        params.agent,
        workspacePath === null && independentAgentModelCatalog(params.agent)
          ? undefined
          : workspacePath,
        accountHomePath
      )
        .then((keepDefault) => {
          if (valid() && bindings.get(bindingKey) === bound) {
            bound.keepDefault = keepDefault
          }
        })
        .catch(() => {})
      if (params.savedOnly) {
        await bound.projecting
        return
      }
      if (!exact && scoped?.lease?.claimStatus === 'released' && scoped.lease.deathEvidence) {
        return
      }
      const probe = deps.probes?.[params.agent]
      const signal = AbortSignal.any([lifetime.signal, controller.signal])
      const list = scopedAgentModelCatalogLister({
        legacy: params.legacy,
        admission,
        signal,
        resolved,
        probe,
        probeHome,
        workspacePath: cwd ?? folder
      })
      if (probe && probeHome && deps.store.probeDue(fingerprint)) {
        void deps.store.refresh(fingerprint, params.agent, probe, list, current)
      }
      // Demand owns ingestion until settlement, even when its caller only needs the snapshot.
      ready.resolve()
      const pending = deps.store.pendingListing(fingerprint, true, true)
      if (pending) {
        await pending
      }
    }
    const promise = Promise.resolve()
      .then(run)
      .catch(() => {})
      .finally(() => {
        ready.resolve()
        if (claims.get(key)?.controller === controller) {
          claims.delete(key)
        }
      })
    claims.set(key, { identity, controller, promise, ready: ready.promise, params })
    while (claims.size > 256) {
      const oldest = claims.keys().next().value
      if (oldest !== undefined) {
        claims.get(oldest)?.controller.abort()
        claims.delete(oldest)
      }
    }
    return promise
  }
  return {
    snapshot,
    demand: (params) => (params.savedOnly ? Promise.resolve() : resolve(params)),
    async prepareSaved(params) {
      if (!memoryBinding(params)) {
        await resolve({ ...params, savedOnly: true })
      }
      return snapshot({ ...params, savedOnly: true })
    },
    captureSource: live.captureSource,
    retireContext,
    peek(sessionId, verifiedOnly) {
      const record = deps.getRecord(sessionId)
      const bound =
        record && memoryBinding({ agent: record.provider, sessionId, inSessionWorkspace: true })
      const entry = bound ? deps.store.observation(bound.fingerprint) : null
      return entry && (!verifiedOnly || deps.store.verified(entry)) ? entry : null
    },
    providerStarted(record, source) {
      const bound = bindings.get(
        requestKey({
          agent: record.provider,
          sessionId: record.sessionId,
          inSessionWorkspace: true
        })
      )
      if (bound?.current() && source?.() !== false) {
        deps.store.expireFailure(bound.fingerprint)
      }
      live.providerStarted(record, source)
    },
    async read(params) {
      if (!params.savedOnly) {
        void resolve(params)
        if (params.waitForListing || params.legacy) {
          await claims.get(requestKey(params))?.ready
          const bound = bindings.get(requestKey(params))
          await bound?.projecting
          if (
            bound &&
            (!deps.store.get(bound.fingerprint) ||
              independentAgentModelCatalog(params.agent) ||
              deps.store.heldReasonDue(bound.fingerprint))
          ) {
            await deps.store.pendingListing(bound.fingerprint, true, params.legacy)
          }
          if (bound && !deps.store.isListing(bound.fingerprint)) {
            await claims.get(requestKey(params))?.promise
          }
        }
      }
      return snapshot(params)
    },
    retainedLiveModelIds: async (_sessionId, listing) => listing.models.map((model) => model.id),
    recordLiveListing: live.recordLiveListing,
    async prewarm() {
      await prewarmAgentModelCatalog(deps, lifetime.signal, (params) => this.read(params))
    },
    stop() {
      lifetime.abort()
      unbindRetirement()
      retireContext()
      deps.store.clearPartialAttempts()
    }
  }
}
