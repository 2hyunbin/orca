import { JournalLegacyRestInitializer } from '../agent-session-journal/journal-legacy-rest-initializer'
import { structuredAgentSessionReplacedRuntimeEnded } from './structured-agent-session-current-work'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'

export function createHostLegacyRestInitializer(
  deps: StructuredAgentSessionHostDeps,
  sessions: StructuredAgentSessionConversations,
  clientDelivery: StructuredAgentSessionClientDelivery
): JournalLegacyRestInitializer {
  return new JournalLegacyRestInitializer({
    database: deps.journalDatabase,
    candidates: () => {
      const visible = new Set(deps.store.listVisibleSessionIds())
      return deps.store
        .listRecords()
        .sort(
          (a, b) =>
            Number(visible.has(b.sessionId)) - Number(visible.has(a.sessionId)) ||
            b.updatedAt - a.updatedAt
        )
        .map((record) => record.sessionId)
    },
    owner: (id) => {
      const record = deps.store.getRecord(id)
      if (!record || sessions.get(id)?.child) {
        return null
      }
      const replaced = deps.store.replacedRuntime(id)
      const lease = record.lease
      return lease.claimStatus === 'released' ||
        !!lease.deathEvidence?.runtimeEnd ||
        structuredAgentSessionReplacedRuntimeEnded(lease, replaced)
        ? JSON.stringify([
            lease.runtimeFence,
            lease.claimStatus,
            lease.ownerProcess,
            lease.reservedSpawnToken
          ])
        : null
    },
    initialized: (id, facts) =>
      clientDelivery.publishAtRest(id, { ...facts, interrupted: facts.openTurn !== null }),
    failed: (sessionId, error) =>
      deps.logger.warn('initializing saved chat status failed', {
        scope: 'legacy-rest',
        sessionId,
        error
      })
  })
}
