import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../shared/structured-agent-session-dispatch-rejection'
import { DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED } from './journal-dispatch-doubt-reasons'

/** The existing uncertain-handoff display projection, shared with its dependency signature. */
export function queuedHandOffDisplaySubmission(
  original: AgentJournalSubmission
): AgentJournalSubmission {
  const submission = { ...original }
  if (dispatchWasWithdrawn(submission) && !submission.answeredInTurn) {
    delete submission.queuedMessageId
  } else {
    submission.dispatchState = 'unknown'
    submission.reason = DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED
    submission.recovered = true
    delete submission.rejection
  }
  return submission
}

export function queuedHandOffDisplayItem(
  item: AgentJournalRenderItem | undefined,
  place: Pick<AgentJournalRenderItem, 'sequence' | 'observedAt' | 'turnScope'> | undefined
): AgentJournalRenderItem | undefined {
  if (!item || !place) {
    return item
  }
  const { sequenceIndex: _rejectedAt, ...rest } = item
  return { ...rest, ...place }
}
