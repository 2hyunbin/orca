// The one decision for whether a committed dispatch row changes a submission's
// effective delivery answer, and what a rejection does to the card it was
// handed off from. The reducer folds rows through the first and the queue's
// fold reads the answer it leaves, so the two can never disagree: a row the
// reducer ignores must not alter a card.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'

/** `rejected` and `accepted` are terminal; a late row for an absent or settled
 *  submission must not reopen the answer. */
export function journalDispatchRowApplies(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined
): boolean {
  return (
    submission !== undefined &&
    submission.dispatchState !== 'rejected' &&
    submission.dispatchState !== 'accepted'
  )
}

/** What a consumed draft becomes when its submission is rejected. */
export type RejectedDraftSettlement = { state: 'returned' | 'waiting' }

/**
 * A withdrawal waits at its original position under the queue's pause; a failure returns the
 * card, except a command refused in its own turn, whose row already reports it.
 */
export function rejectedDraftSettlement(
  rejected: Pick<AgentJournalSubmission, 'reason'> & { rejection?: unknown }
): RejectedDraftSettlement {
  return { state: classifyDispatchRejection(rejected).verdict !== null ? 'returned' : 'waiting' }
}
