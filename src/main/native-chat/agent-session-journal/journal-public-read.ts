import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { renderJournalState, type JournalReducerState } from './journal-reducer'

/** Row progress cannot certify a historical display that the queue fold corrected. */
export function readJournalPublicView(state: JournalReducerState): {
  snapshot: AgentJournalSnapshot
  normalizationKey: string
} {
  const corrections = [...state.normalizedHandOffs].sort().flatMap((id) => {
    const item = state.items.get(agentJournalSubmissionKey(id))
    const submission = state.submissions.get(id)
    return item && submission
      ? [
          [
            id,
            item.sequence,
            item.observedAt,
            item.turnScope,
            submission.dispatchState,
            submission.queuedMessageId ?? null
          ]
        ]
      : []
  })
  return {
    snapshot: renderJournalState(state),
    normalizationKey: corrections.length === 0 ? '' : JSON.stringify([state.epoch, corrections])
  }
}
