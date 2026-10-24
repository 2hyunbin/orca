import { structuredJournalBackgroundReady } from './structured-agent-session-registry'
import { JournalLegacyRestInitializer } from '../agent-session-journal/journal-legacy-rest-initializer'
import { orderedLegacyRestCandidates } from './structured-agent-session-legacy-candidates'
import {
  structuredAgentSessionReplacedRuntimeEnded,
  structuredAgentSessionOwnerEnded
} from './structured-agent-session-current-work'
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
    candidates: () => orderedLegacyRestCandidates(deps.store),
    needsPublication: (id) => clientDelivery.hasUnknownRestart(id),
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
    initialized: (id, facts) => {
      const record = deps.store.getRecord(id)
      clientDelivery.publishAtRest(id, {
        ...facts,
        interrupted:
          facts.openTurn !== null &&
          !!record &&
          structuredAgentSessionOwnerEnded(record.lease, deps.store.replacedRuntime(id))
      })
    },
    failed: (sessionId, error) =>
      deps.logger.warn('initializing saved chat status failed', {
        scope: 'legacy-rest',
        sessionId,
        error
      })
  })
}

export function advanceHostLegacyRest(initializer: JournalLegacyRestInitializer | undefined): void {
  initializer?.advance(structuredJournalBackgroundReady)
}
