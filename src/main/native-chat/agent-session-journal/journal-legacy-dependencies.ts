import { serialize } from 'node:v8'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { journalDispatchRowApplies, queuedHandOffOutcome } from './journal-dispatch-settlement'
import {
  queuedHandOffDisplayItem,
  queuedHandOffDisplaySubmission
} from './journal-queued-hand-off-display'
import type { JournalReducerState } from './journal-reducer'

/** Only original classifier/display inputs can invalidate readable legacy dependents. */
export function legacyRawDependency(
  raw: string,
  submission: AgentJournalSubmission | undefined,
  state: JournalReducerState
): string {
  const outcome =
    submission?.dispatchState === 'rejected' ? queuedHandOffOutcome(submission) : undefined
  const classification = !submission
    ? undefined
    : outcome === undefined
      ? ['present', journalDispatchRowApplies(submission)]
      : [
          'rejected',
          outcome,
          ...(outcome === 'returned' ? [submission.reason, submission.rejection ?? null] : [])
        ]
  const correction =
    outcome === 'inDoubt' && submission
      ? [
          queuedHandOffDisplaySubmission(submission),
          queuedHandOffDisplayItem(
            state.items.get(agentJournalSubmissionKey(raw)),
            state.queuedHandOffPlaces.get(raw)
          )
        ]
      : undefined
  return serialize([classification, correction]).toString('base64')
}

export function legacyAttemptDependency(submission: AgentJournalSubmission | undefined): string {
  if (!submission || submission.queuedMessageId === undefined) {
    return ''
  }
  const inDoubt =
    submission.dispatchState === 'rejected' && queuedHandOffOutcome(submission) === 'inDoubt'
  return serialize([
    submission.queuedMessageId,
    submission.clientMessageId,
    submission.submittedSequence ?? 0,
    inDoubt,
    inDoubt ? submission.payloadFingerprint : undefined
  ]).toString('base64')
}
