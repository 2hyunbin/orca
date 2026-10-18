import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { homedir } from 'node:os'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord,
  agentModelCatalogScopeFingerprint
} from './agent-model-catalog-fingerprint'
import {
  agentModelCatalogResultFromEntry,
  agentModelCatalogSessionObservation,
  retainedAgentModelCatalogModels,
  type AgentModelCatalogConfiguredChoice
} from './agent-model-catalog-entry'
import type { AgentModelCatalogEntry } from './agent-model-catalog-store'
import { rememberDiscoveryScope } from './agent-model-catalog-discovery'
import { AgentModelCatalogListingStoppedError } from './agent-model-catalog-failures'

import type {
  AgentModelCatalogRead,
  AgentModelCatalogService,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
export type {
  AgentModelCatalogService,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'

async function recordConfiguredDefault(
  deps: AgentModelCatalogServiceDeps,
  record: AgentSessionRecord,
  fingerprint: string,
  choice: AgentModelCatalogConfiguredChoice | null
): Promise<void> {
  const accountHome = record.accountHome
  if (!deps.workspaceMayOverrideDefaultModel) {
    return
  }
  const workspacePath = isNativeLocalLocation(record.location)
    ? await deps.recordWorkspacePath?.(record).catch(() => null)
    : null
  if (
    !workspacePath ||
    (await deps.workspaceMayOverrideDefaultModel({
      agent: record.provider,
      workspacePath,
      accountHomePath: isLegacyAgentSessionAccountHome(accountHome) ? accountHome.path : null
    }))
  ) {
    return
  }
  deps.store.recordConfiguredDefault(fingerprint, choice)
}

export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  const lifetime = new AbortController()
  const admission = new PrioritySemaphore(2)
  const sessionKeys = new Map<string, string>()
  const recordingDefaults = new Map<string, Promise<void>>()
  const retainedKey = (sessionId: string): string => {
    const record = deps.getRecord(sessionId)
    return record &&
      deps.drivesRecord(record) &&
      (isNativeLocalLocation(record.location) || record.location.wslDistro !== null)
      ? (record.provider === 'claude' || record.provider === 'codex') &&
        isNativeLocalLocation(record.location)
        ? (sessionKeys.get(sessionId) ?? '')
        : agentModelCatalogFingerprintForRecord(record)
      : ''
  }
  const read = async (params: AgentModelCatalogRead): Promise<AgentSessionModelCatalogResult> => {
    const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
    if (
      record &&
      (record.provider !== params.agent ||
        !deps.drivesRecord(record) ||
        (!isNativeLocalLocation(record.location) && record.location.wslDistro === null))
    ) {
      return { origin: 'unknown' }
    }
    const home =
      record?.accountHome ?? (await deps.resolveAccountHome(params.agent).catch(() => null))
    if (!home) {
      return { origin: 'unknown' }
    }
    const native = !record || isNativeLocalLocation(record.location)
    const base = record
      ? agentModelCatalogFingerprintForRecord(record)
      : agentModelCatalogFingerprint({
          agent: params.agent,
          accountHome: home,
          wslDistro: null
        })
    const independent = native && (params.agent === 'claude' || params.agent === 'codex')
    const legacyAccount = params.legacy && independent
    const workspacePath = async () =>
      !native
        ? null
        : params.accountDefault && !legacyAccount
          ? homedir()
          : params.workspacePath === null
            ? null
            : (params.workspacePath ??
              (record ? await deps.recordWorkspacePath?.(record).catch(() => null) : homedir()))
    const cwd = legacyAccount || !independent ? undefined : await workspacePath()
    if (!cwd && !legacyAccount && independent) {
      const legacy = deps.store.get(base)
      if (!legacy) {
        return { origin: 'unknown' }
      }
      return {
        ...agentModelCatalogResultFromEntry(legacy, false, false),
        models: legacy.models.map((row) => ({ ...row, isDefault: false }))
      }
    }
    const namesDefault = async (): Promise<boolean> => {
      if (
        params.accountDefault ||
        (params.workspacePath === undefined && !params.inSessionWorkspace)
      ) {
        return true
      }
      const directory = legacyAccount || !independent ? await workspacePath() : cwd
      return directory && deps.workspaceMayOverrideDefaultModel
        ? !(await deps
            .workspaceMayOverrideDefaultModel({
              agent: params.agent,
              workspacePath: directory,
              accountHomePath: isLegacyAgentSessionAccountHome(home) ? home.path : null
            })
            .catch(() => true))
        : false
    }
    const probe = native ? deps.probes?.[params.agent] : undefined
    const resolved = cwd
      ? await probe
          ?.resolve?.(home, cwd, params.accountDefault ? undefined : record?.options)
          .catch(() => null)
      : undefined
    if (independent && !legacyAccount && probe?.resolve && !resolved) {
      return { origin: 'unknown' }
    }
    const fingerprint = independent
      ? agentModelCatalogScopeFingerprint(
          base,
          legacyAccount ? 'legacy-account' : (cwd ?? ''),
          resolved?.identity
        )
      : base
    if (independent && params.sessionId && !params.accountDefault && !params.legacy) {
      rememberDiscoveryScope(sessionKeys, params.sessionId, fingerprint)
    }
    await recordingDefaults.get(fingerprint)
    let entry = deps.store.get(fingerprint)
    // Old cache identities remain usable only through the legacy flat display contract.
    const legacy = entry ? null : deps.store.get(base)
    const answer = async (
      listed: AgentModelCatalogEntry | null,
      listingInProgress = false
    ): Promise<AgentSessionModelCatalogResult> => {
      const unavailable = deps.store.failure(fingerprint)?.unavailable
      const display = listed ?? legacy
      const result = display
        ? agentModelCatalogResultFromEntry(
            display,
            (listed !== null || params.legacy === true) && (await namesDefault()),
            deps.listingNamesConfiguredModel?.has(params.agent) === true
          )
        : null
      return {
        ...(result ?? { origin: 'unknown' as const }),
        ...(result?.listingNamesConfiguredModel === true &&
        deps.agentReadsProjectModelConfig?.(params.agent) === false
          ? { defaultHoldsInEveryWorkspace: true as const }
          : {}),
        ...(listingInProgress ? { listingInProgress: true as const } : {}),
        ...(unavailable ? { unavailable } : {})
      }
    }
    if (
      params.savedOnly ||
      ((params.legacy || !independent) &&
        record?.lease?.claimStatus === 'released' &&
        record.lease.deathEvidence)
    ) {
      return answer(entry)
    }
    if (probe && !lifetime.signal.aborted && deps.store.probeDue(fingerprint)) {
      deps.store.refresh(fingerprint, params.agent, probe, async () => {
        try {
          const release = legacyAccount ? () => {} : await admission.acquire(0, lifetime.signal)
          try {
            const result =
              legacyAccount && probe.resolveLegacy
                ? await (await probe.resolveLegacy(home)).run(lifetime.signal)
                : resolved
                  ? await resolved.run(lifetime.signal)
                  : await probe(home, {
                      ...(legacyAccount || !cwd ? {} : { cwd }),
                      signal: lifetime.signal
                    })
            return result
          } finally {
            release()
          }
        } catch (error) {
          if (lifetime.signal.aborted) {
            throw new AgentModelCatalogListingStoppedError(String(error))
          }
          throw error
        }
      })
    }
    if (params.waitForListing && deps.store.isListing(fingerprint)) {
      await deps.store.pendingListing(fingerprint, entry)
      entry = deps.store.get(fingerprint)
    }
    return answer(entry, deps.store.isListing(fingerprint))
  }
  return {
    read,
    peek: (sessionId, verifiedOnly) => {
      const entry = deps.store.get(retainedKey(sessionId))
      return entry &&
        (!verifiedOnly ||
          (sessionKeys.get(sessionId) === entry.fingerprint &&
            deps.store.freshForMs(entry) > 0 &&
            !deps.store.hasActiveFailure(entry.fingerprint) &&
            !deps.store.failure(entry.fingerprint)?.unavailable))
        ? entry
        : null
    },
    providerStarted(record) {
      const key = sessionKeys.get(record.sessionId)
      if (key) {
        deps.store.expireFailure(key)
      }
      const account = agentModelCatalogFingerprintForRecord(record)
      deps.store.expireFailure(account)
      deps.store.expireFailure(agentModelCatalogScopeFingerprint(account, 'legacy-account'))
    },
    retainedLiveModelIds(sessionId, listing) {
      return retainedAgentModelCatalogModels(deps.store.get(retainedKey(sessionId)), listing).map(
        (model) => model.id
      )
    },
    recordLiveListing(sessionId, listing) {
      const record = deps.getRecord(sessionId)
      if (
        !record ||
        !deps.drivesRecord(record) ||
        record.provider === 'claude' ||
        record.provider === 'codex'
      ) {
        return
      }
      const fingerprint = agentModelCatalogFingerprintForRecord(record)
      const { configuredDefault, ...listed } = listing
      const saved = deps.store.recordSuccess(
        fingerprint,
        record.provider,
        agentModelCatalogSessionObservation({
          ...listed,
          models: retainedAgentModelCatalogModels(deps.store.get(fingerprint), listing)
        }),
        'live'
      )
      if (saved && configuredDefault !== undefined) {
        const recording = (recordingDefaults.get(fingerprint) ?? Promise.resolve())
          .then(() => recordConfiguredDefault(deps, record, fingerprint, configuredDefault))
          .catch(() => {})
          .then(() => {
            if (recordingDefaults.get(fingerprint) === recording) {
              recordingDefaults.delete(fingerprint)
            }
          })
        recordingDefaults.set(fingerprint, recording)
      }
    },
    async prewarm() {
      if (lifetime.signal.aborted) {
        return
      }
      await Promise.all(
        Object.keys(deps.probes ?? {})
          .filter((agent) => deps.store.hasEntryForAgent(agent) || deps.hasChatRecords?.(agent))
          .map((agent) => read({ agent, waitForListing: true }).catch(() => {}))
      )
    },
    stop() {
      lifetime.abort()
      sessionKeys.clear()
    }
  }
}
