import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { JournalQueuedChange } from './journal-queue-events'
import { journalDispatchRowApplies, queuedHandOffOutcome } from './journal-dispatch-settlement'
import { queuedCardFromChange } from './journal-queue-fold'
import { queuedChangeOf } from './journal-queue-retention'
import type { JournalReducerState } from './journal-reducer'
import {
  QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED,
  type QueuedMessageRow
} from './queued-message-table'

/** Preserve handoff links; copy refusals only when their original rows are no longer in this epoch. */
export function legacyQueuedChange(
  state: JournalReducerState,
  row: QueuedMessageRow
): JournalQueuedChange | null {
  const unconfirmed = row.state === 'waiting' ? unconfirmedHandOff(state, row) : null
  const attempt = row.state === 'waiting' ? (unconfirmed?.attempt ?? null) : row.consumedAs
  if (row.state === 'withdrawn' || (row.state === 'dispatched' && attempt === null)) {
    return null
  }
  const holdReason = unconfirmed?.holdReason ?? (row.state === 'waiting' ? row.holdReason : null)
  const change: JournalQueuedChange = {
    ...queuedChangeOf(row),
    ...(holdReason !== null ? { holdReason } : {}),
    ...(attempt !== null ? { attempt } : {}),
    ...(row.state === 'returned' && (attempt === null || !state.submissions.has(attempt))
      ? {
          returned: {
            reason: row.returnedReason,
            ...(row.returnedRejection ? { rejection: row.returnedRejection } : {})
          }
        }
      : {})
  }
  const card = queuedCardFromChange(state, row.messageId, change)
  return unanswered(card, state.submissions) ? change : null
}

/** Legacy refusals may have cleared handoff links without proving non-delivery.
 * Spend unchanged cards on uncertain attempts; edited/resubmitted cards require explicit Send. */
function unconfirmedHandOff(
  state: JournalReducerState,
  row: QueuedMessageRow
):
  | { attempt: string; holdReason?: undefined }
  | { attempt?: undefined; holdReason: string }
  | null {
  if (!state.selection.groups.has(`doubt:${row.messageId}`)) {
    return null
  }
  const id = state.selection.order.maximum(`attempt:${row.messageId}`, true)?.key
  const latest = id === undefined ? undefined : state.submissions.get(id)
  return latest && handOffInDoubt(latest) && latest.payloadFingerprint === row.fingerprint
    ? { attempt: latest.clientMessageId }
    : { holdReason: QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED }
}

export function handOffInDoubt(submission: AgentJournalSubmission): boolean {
  return submission.dispatchState === 'rejected' && queuedHandOffOutcome(submission) === 'inDoubt'
}

function unanswered(
  card: QueuedMessageRow,
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): boolean {
  if (card.state !== 'dispatched') {
    return card.state !== 'withdrawn'
  }
  const handOff = card.consumedAs === null ? undefined : submissions.get(card.consumedAs)
  return handOff === undefined || journalDispatchRowApplies(handOff) || handOffInDoubt(handOff)
}
