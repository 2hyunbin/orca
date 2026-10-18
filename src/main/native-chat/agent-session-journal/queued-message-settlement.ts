// What a journal row does to the drafts, and the re-derivation behind it. The
// live hook runs inside each append's transaction; it is bookkeeping and may be
// skipped, so every reader takes the card the fold already settled
// (`effectiveQueuedCard`), and the open-time repair and the drain write that
// card's durable copy.

import type Database from '../../sqlite/sync-database'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { journalDispatchRowNewlyRejects } from './journal-dispatch-settlement'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { draftDeliveredByEcho, draftsDeliveredByAppliedEcho } from './queued-message-delivered-echo'
import {
  commandTurnReported,
  effectiveQueuedCard,
  rejectedCardTransition,
  writeEffectiveQueuedCards
} from './queued-message-effective-card'
import {
  listQueuedMessages,
  withdrawQueuedMessages,
  type QueuedMessageRow
} from './queued-message-table'

type Submissions = ReadonlyMap<string, AgentJournalSubmission>

/** A card waits, or is mid-hand-off and may come back to waiting: a chat that stops running
 *  marks it (`AgentSessionJournal.markQueueReopen`). */
export function queuedMessagesAwaitReopenMark(
  rows: readonly QueuedMessageRow[],
  submissions: Submissions
): boolean {
  return rows.some((row) => {
    if (row.state === 'waiting') {
      return true
    }
    const handOff = row.consumedAs ? submissions.get(row.consumedAs)?.dispatchState : undefined
    return row.state === 'dispatched' && (handOff === 'pending' || handOff === 'unknown')
  })
}

/** Stores each card the fold already settled (`effectiveQueuedCard`), and withdraws each waiting
 *  draft an applied echo proves delivered (`draftsDeliveredByAppliedEcho`); returns how many
 *  drafts changed. */
export function settleOwedQueuedMessages(
  db: Database.Database,
  input: { sessionId: string; state: JournalReducerState; now: number }
): number {
  let settled = writeEffectiveQueuedCards(db, input, (row) => effectiveQueuedCard(row, input.state))
  const delivered = draftsDeliveredByAppliedEcho(
    input.state,
    listQueuedMessages(db, input.sessionId)
  )
  if (delivered.length > 0) {
    settled += withdrawQueuedMessages(db, {
      sessionId: input.sessionId,
      messageIds: delivered,
      settledByOp: null,
      now: input.now
    }).length
  }
  return settled
}

/**
 * The live hook, before `row` applies: an echo proving a waiting draft's first
 * send was delivered withdraws it; a row that NEWLY settles a dispatched
 * draft's current submission to `rejected` settles the draft — a refusal
 * returns it, a withdrawal (a Stop, a restart) sends it back to waiting
 * (`rejectedDraftSettlement`).
 * Decided by the same function the reducer folds rows through, so a row the
 * journal's settlement rules ignore never alters a draft. Returns how many
 * drafts changed.
 */
export function settleQueuedMessagesForRow(
  db: Database.Database,
  input: {
    sessionId: string
    state: JournalReducerState
    /** Read only once the row holds an unclaimed echo: a list read inside the append's
     *  transaction must not be cached under state a rollback could undo. */
    drafts: () => readonly QueuedMessageRow[]
    row: JournalRow
    now: number
  }
): number {
  const { row } = input
  let changed = 0
  const delivered = draftDeliveredByEcho(input.state, input.drafts, row)
  if (delivered !== null) {
    // Its first send reached the agent after all; sending it again would repeat it. Stored first
    // as readers see it, so a card still stored as handed off is withdrawn too.
    changed += writeEffectiveQueuedCards(db, { ...input, messageIds: [delivered] }, (card) =>
      effectiveQueuedCard(card, input.state)
    )
    changed += withdrawQueuedMessages(db, {
      sessionId: input.sessionId,
      messageIds: [delivered],
      settledByOp: null,
      now: input.now
    }).length
  }
  if (row.kind !== 'dispatch' || row.state !== 'rejected') {
    return changed
  }
  const submission = input.state.submissions.get(row.clientMessageId)
  if (!journalDispatchRowNewlyRejects(submission, row)) {
    return changed
  }
  // Not folded in yet, so the row's own facts take the view's decision.
  const reported = commandTurnReported(input.state, row.clientMessageId)
  return (
    changed +
    writeEffectiveQueuedCards(db, input, (card) =>
      card.state === 'dispatched' && card.consumedAs === row.clientMessageId
        ? rejectedCardTransition(card, row, reported)
        : card
    )
  )
}
