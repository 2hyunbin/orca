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
import {
  atRestCommandContextRevision,
  onAtRestCommandContextRetired
} from '../agent-session-wire/at-rest-command-context'
import {
  projectAgentModelCatalogSnapshot,
  type AgentModelCatalogBinding
} from './agent-model-catalog-snapshot'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'

export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  // One per host: stopping it ends every listing this service started.
  const lifetime = new AbortController()
  const admission = new PrioritySemaphore(2)
  const sessionKeys = new Map<string, { fingerprint: string; current: () => boolean }>()
  const live = createAgentModelCatalogLiveListings(deps)
  type Claim = {
    identity: string
    controller: AbortController
    promise: Promise<void>
    ready: Promise<void>
  }
  const bindings = new Map<string, AgentModelCatalogBinding>()
  const claims = new Map<string, Claim>()
  const requestKey = (params: AgentModelCatalogReadParams): string =>
    JSON.stringify({
      agent: params.agent,
      sessionId: params.sessionId,
      selector: params.workspace?.selector,
      workspacePath: params.workspacePath,
      inSessionWorkspace: params.inSessionWorkspace,
      legacy: params.legacy
    })
  const capture = (params: AgentModelCatalogReadParams): string => {
    const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
    return JSON.stringify([
      atRestCommandContextRevision(),
      deps.store.retirementRevision(params.agent),
      params.workspace?.identity(),
      record && [
        record.provider,
        record.accountHome,
        record.location,
        record.launchDirectory,
        deps.drivesRecord(record)
      ]
    ])
  }
  const retireContext = (): void => {
    for (const claim of claims.values()) {
      claim.controller.abort()
    }
    claims.clear()
    bindings.clear()
    sessionKeys.clear()
    for (const agent of Object.keys(deps.probes ?? {})) {
      deps.store.expireAgent(agent)
    }
  }
  const unbindRetirement = onAtRestCommandContextRetired(retireContext)
  const snapshot = (params: AgentModelCatalogReadParams): AgentSessionModelCatalogResult => {
    const key = requestKey(params)
    const bound = bindings.get(key)
    if (lifetime.signal.aborted || !bound || bound.identity !== capture(params)) {
      return {
        origin: 'unknown',
        ...(!params.savedOnly && claims.get(key)?.identity === capture(params)
          ? { listingInProgress: true as const }
          : {})
      }
    }
    return projectAgentModelCatalogSnapshot(deps, params, bound, claims.has(key))
  }

  const demand = (params: AgentModelCatalogReadParams): Promise<void> => {
    if (lifetime.signal.aborted || params.savedOnly) {
      return Promise.resolve()
    }
    const key = requestKey(params)
    const identity = capture(params)
    const previous = claims.get(key)
    if (previous?.identity === identity) {
      return previous.promise
    }
    previous?.controller.abort()
    const controller = new AbortController()
    const ready = Promise.withResolvers<void>()
    const current = (): boolean =>
      !controller.signal.aborted &&
      !lifetime.signal.aborted &&
      claims.get(key)?.identity === identity &&
      capture(params) === identity
    const run = async (): Promise<void> => {
      const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
      const scoped =
        record && record.provider === params.agent && deps.drivesRecord(record) ? record : undefined
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
      if (scoped && exact) {
        if (sessionKeys.size >= 256 && !sessionKeys.has(scoped.sessionId)) {
          const oldest = sessionKeys.keys().next().value
          if (oldest !== undefined) {
            sessionKeys.delete(oldest)
          }
        }
        sessionKeys.set(scoped.sessionId, {
          fingerprint,
          current: () => capture(params) === identity
        })
      }
      if (!current()) {
        return
      }
      const bound: AgentModelCatalogBinding = {
        identity,
        fingerprint,
        base,
        exact,
        folder,
        workspacePath,
        keepDefault: workspacePath === undefined
      }
      bindings.set(key, bound)
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
        workspacePath,
        accountHomePath
      )
        .then((keepDefault) => {
          if (current() || (bindings.get(key) === bound && capture(params) === identity)) {
            bound.keepDefault = keepDefault
          }
        })
        .catch(() => {})
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
    claims.set(key, { identity, controller, promise, ready: ready.promise })
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
    demand,
    retireContext,
    peek(sessionId, verifiedOnly) {
      const key = sessionKeys.get(sessionId)
      const entry = key?.current() ? deps.store.get(key.fingerprint) : null
      return entry && (!verifiedOnly || deps.store.verified(entry)) ? entry : null
    },
    providerStarted(record) {
      const key = sessionKeys.get(record.sessionId)
      if (key) {
        deps.store.expireFailure(key.fingerprint)
      }
      live.providerStarted(record)
    },
    async read(params) {
      if (!params.savedOnly) {
        void demand(params)
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
        }
      }
      return snapshot(params)
    },
    async retainedLiveModelIds(_sessionId, listing) {
      return listing.models.map((model) => model.id)
    },
    recordLiveListing: live.recordLiveListing,
    async prewarm() {
      await prewarmAgentModelCatalog(deps, lifetime.signal, (params) => this.read(params))
    },
    stop() {
      lifetime.abort()
      unbindRetirement()
      retireContext()
      sessionKeys.clear()
      deps.store.clearPartialAttempts()
    }
  }
}
