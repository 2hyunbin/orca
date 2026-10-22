import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentModelCatalogLiveListing } from './agent-model-catalog-store'
import type { AgentModelCatalogServiceDeps } from './agent-model-catalog-service-contract'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { catalogFolder, recordConfiguredDefault } from './agent-model-catalog-workspace'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import { onAtRestCommandContextRetired } from '../agent-session-wire/at-rest-command-context'

export function createAgentModelCatalogLiveListings(
  deps: AgentModelCatalogServiceDeps,
  signal: AbortSignal
) {
  const workspaces = new Map<string, object>()
  const retireContext = (workspaceId?: string): void => {
    if (workspaceId === undefined) {
      workspaces.clear()
    } else {
      workspaces.delete(workspaceId)
    }
  }
  const unbind = onAtRestCommandContextRetired((workspaceId) => {
    if (workspaceId !== undefined) {
      retireContext(workspaceId)
    }
  })
  signal.addEventListener(
    'abort',
    () => {
      unbind()
      workspaces.clear()
    },
    { once: true }
  )
  const recordIdentity = (record: AgentSessionRecord): string =>
    JSON.stringify([
      record.provider,
      record.accountHome,
      record.location,
      record.launchDirectory,
      deps.drivesRecord(record)
    ])
  const captureSource = (record: AgentSessionRecord): (() => boolean) => {
    const workspace = record.location.workspaceId
    const owner = workspaces.get(workspace) ?? {}
    workspaces.set(workspace, owner)
    if (workspaces.size > 256) {
      workspaces.delete(workspaces.keys().next().value ?? '')
    }
    const revision = deps.store.retirementRevision(record.provider)
    const identity = recordIdentity(record)
    return () =>
      !signal.aborted &&
      workspaces.get(workspace) === owner &&
      deps.store.retirementRevision(record.provider) === revision &&
      recordIdentity(deps.getRecord(record.sessionId) ?? record) === identity
  }
  // Default projections retain report order without delaying inventory observations.
  const recordingDefaults = new Map<string, Promise<void>>()
  // A running chat's saves for agents kept per folder, which wait on a folder lookup.
  const liveWrites = new Map<string, Promise<void>>()
  /** The catalog a session's own listings belong to: its pinned account and host, and its folder
   *  for an agent kept per folder. */
  const sessionCatalogKey = async (record: AgentSessionRecord): Promise<string> =>
    agentModelCatalogFingerprintForRecord(
      record,
      await catalogFolder(deps, record.provider, undefined, record)
    )
  const saveLiveListing = (
    record: AgentSessionRecord,
    listing: AgentModelCatalogLiveListing,
    fingerprint: string,
    current: () => boolean
  ): void => {
    if (!current()) {
      return
    }
    const { configuredDefault, ...listed } = listing
    const saved = deps.store.recordSuccess(
      fingerprint,
      record.provider,
      { ...listed, origin: 'live-session' },
      'live'
    )
    if (saved && configuredDefault !== undefined) {
      // In report order, so the latest chat's resolution is the one kept.
      const recording = (recordingDefaults.get(fingerprint) ?? Promise.resolve())
        .then(() => recordConfiguredDefault(deps, record, fingerprint, configuredDefault, current))
        .catch(() => {})
        .then(() => {
          if (recordingDefaults.get(fingerprint) === recording) {
            recordingDefaults.delete(fingerprint)
          }
        })
      recordingDefaults.set(fingerprint, recording)
    }
  }
  return {
    captureSource,
    retireContext,
    providerStarted(record: AgentSessionRecord, source?: () => boolean) {
      const receipt = captureSource(record)
      const current = () => receipt() && source?.() !== false
      if (!current()) {
        return
      }
      if (!deps.listsInChatFolder?.has(record.provider)) {
        deps.store.expireFailure(agentModelCatalogFingerprintForRecord(record))
        return
      }
      void sessionCatalogKey(record)
        .then((fingerprint) => {
          if (current()) {
            deps.store.expireFailure(fingerprint)
          }
        })
        .catch(() => {})
    },
    recordLiveListing(
      sessionId: string,
      listing: AgentModelCatalogLiveListing,
      source?: () => boolean
    ) {
      const record = deps.getRecord(sessionId)
      if (!record || !deps.drivesRecord(record) || independentAgentModelCatalog(record.provider)) {
        return
      }
      const receipt = captureSource(record)
      const current = () => receipt() && source?.() !== false
      if (!current()) {
        return
      }
      if (!deps.listsInChatFolder?.has(record.provider)) {
        saveLiveListing(record, listing, agentModelCatalogFingerprintForRecord(record), current)
        return
      }
      // In report order: a folder lookup that resolves late must not let an older listing land last.
      const writing = (liveWrites.get(sessionId) ?? Promise.resolve())
        .then(async () =>
          saveLiveListing(record, listing, await sessionCatalogKey(record), current)
        )
        .catch((error: unknown) => {
          console.warn('[agent-model-catalog] could not save a chat model list:', error)
        })
        .finally(() => {
          if (liveWrites.get(sessionId) === writing) {
            liveWrites.delete(sessionId)
          }
        })
      liveWrites.set(sessionId, writing)
    }
  }
}
