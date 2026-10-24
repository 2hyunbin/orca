import {
  restartRowsFor,
  type StructuredAgentSessionRestartAudience,
  type StructuredAgentSessionResumeCandidate
} from './structured-agent-session-restart-resume-set'
import type { createStructuredAgentSessionRestartCandidateReaders } from './structured-agent-session-restart-candidates'
import type { createStructuredAgentSessionRestartOfferRecords } from './structured-agent-session-restart-offer-records'
import { materializeJournalLegacyCut } from '../agent-session-journal/journal-row-table'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export function materializeRestartMarkers(
  deps: Pick<StructuredAgentSessionHostDeps, 'journalDatabase' | 'logger'>,
  markers: readonly AgentSessionResumeMarker[]
): void {
  for (const marker of markers) {
    try {
      materializeJournalLegacyCut(deps.journalDatabase.db, marker.sessionId, marker.recordedAt)
    } catch (error) {
      deps.logger.warn('saving legacy restart fact failed', {
        sessionId: marker.sessionId,
        error
      })
    }
  }
}

export function createRestartListing(
  deps: Pick<StructuredAgentSessionHostDeps, 'journalDatabase' | 'logger'>,
  readMarkers: ReturnType<typeof createStructuredAgentSessionRestartOfferRecords>['readMarkers'],
  derive: ReturnType<typeof createStructuredAgentSessionRestartCandidateReaders>['derive'],
  retireSuperseded: ReturnType<
    typeof createStructuredAgentSessionRestartOfferRecords
  >['retireSuperseded']
) {
  return async (
    audience?: StructuredAgentSessionRestartAudience
  ): Promise<StructuredAgentSessionResumeCandidate[]> => {
    const markers = await readMarkers()
    materializeRestartMarkers(deps, markers)
    // Listing opens no chat: the record and the marker are the offer. A send that moved a chat on
    // started its agent, which withdrew the offer; an open chat is also read against its journal.
    // A live chat remains an offer. The user may have opened it to inspect the context and still
    // explicitly choose whether Orca should ask the agent to continue.
    const { candidates, superseded } = derive(markers, 'may-be-held')
    retireSuperseded(superseded)
    return restartRowsFor(candidates, audience)
  }
}
