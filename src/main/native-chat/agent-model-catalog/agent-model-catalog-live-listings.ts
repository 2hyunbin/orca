import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentModelCatalogLiveListing } from './agent-model-catalog-store'
import type { AgentModelCatalogServiceDeps } from './agent-model-catalog-service-contract'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { catalogFolder, recordConfiguredDefault } from './agent-model-catalog-workspace'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'

export function createAgentModelCatalogLiveListings(deps: AgentModelCatalogServiceDeps) {
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
    fingerprint: string
  ): void => {
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
        .then(() => recordConfiguredDefault(deps, record, fingerprint, configuredDefault))
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
    providerStarted(record: AgentSessionRecord) {
      if (!deps.listsInChatFolder?.has(record.provider)) {
        deps.store.expireFailure(agentModelCatalogFingerprintForRecord(record))
        return
      }
      void sessionCatalogKey(record)
        .then((fingerprint) => deps.store.expireFailure(fingerprint))
        .catch(() => {})
    },
    recordLiveListing(sessionId: string, listing: AgentModelCatalogLiveListing) {
      const record = deps.getRecord(sessionId)
      if (!record || !deps.drivesRecord(record) || independentAgentModelCatalog(record.provider)) {
        return
      }
      if (!deps.listsInChatFolder?.has(record.provider)) {
        saveLiveListing(record, listing, agentModelCatalogFingerprintForRecord(record))
        return
      }
      // In report order: a folder lookup that resolves late must not let an older listing land last.
      const writing = (liveWrites.get(sessionId) ?? Promise.resolve())
        .then(async () => saveLiveListing(record, listing, await sessionCatalogKey(record)))
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
