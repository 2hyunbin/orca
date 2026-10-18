// A card as every reader sees it. A refused hand-off is a journal row; moving its card out of
// `dispatched` is bookkeeping that may be skipped, so readers derive the card from the fold and
// the stored row is only a durable copy (the text a rewind must not delete), written through
// `writeEffectiveQueuedCards` by the live hook, the heal and the action about to change the card.

import type Database from '../../sqlite/sync-database'
import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import {
  consumedSubmissionWasRejected,
  rejectedDraftSettlement
} from './journal-dispatch-settlement'
import type { JournalReducerState } from './journal-reducer'
import type { JournalQueuedMessagesDeps } from './journal-store-contracts'
import { getQueuedMessage, listQueuedMessages, type QueuedMessageRow } from './queued-message-table'

type FoldFacts = Pick<JournalReducerState, 'submissions' | 'items'>

/**
 * What a refusal makes of the dispatched card it handed off: a withdrawal waits again at its own
 * position under the queue's pause; a failure returns the card with its reason, except a command
 * refused in its own turn, which is spent because that turn's row says why and a returned card
 * would hold every card behind it.
 */
export function rejectedCardTransition(
  card: QueuedMessageRow,
  rejected: { reason: string | null; rejection?: UnreadAgentSessionFailureFact },
  commandTurnReported: boolean
): QueuedMessageRow {
  if (rejectedDraftSettlement(rejected).state === 'waiting') {
    return {
      ...card,
      state: 'waiting',
      holdReason: null,
      consumedAs: null,
      returnedReason: null,
      returnedRejection: null,
      settledAt: null,
      settledByOp: null
    }
  }
  if (card.body.command && commandTurnReported) {
    return { ...card, state: 'withdrawn' }
  }
  return {
    ...card,
    state: 'returned',
    returnedReason: rejected.reason,
    returnedRejection: rejected.rejection ?? null
  }
}

/** The stored card, settled as its refused hand-off says; any other card is the same object. */
export function effectiveQueuedCard(row: QueuedMessageRow, state: FoldFacts): QueuedMessageRow {
  const submission = row.consumedAs === null ? undefined : state.submissions.get(row.consumedAs)
  if (row.state !== 'dispatched' || !submission || !consumedSubmissionWasRejected(submission)) {
    return row
  }
  return rejectedCardTransition(
    row,
    submission,
    commandTurnReported(state, submission.clientMessageId)
  )
}

/** The submission's command turn is in the journal: its own row reports the refusal. */
export function commandTurnReported(state: FoldFacts, clientMessageId: string): boolean {
  return state.items.has(
    agentJournalItemKey(structuredAgentSessionCommandTurnIdentity(clientMessageId))
  )
}

/** The cards readers see over the stored rows, and the durable copy an action writes first. */
export class EffectiveQueuedCardView {
  private stored: { revision: number; rows: readonly QueuedMessageRow[] } | null = null
  private viewed: { key: string; cards: readonly QueuedMessageRow[] } | null = null

  constructor(
    private readonly deps: Pick<
      JournalQueuedMessagesDeps,
      'sessionId' | 'now' | 'database' | 'state'
    >,
    /** Bumped on every draft-table write. */
    private readonly tableRevision: () => number
  ) {}

  /** Also moves when the fold settles a stored hand-off, which changes a card with no write. */
  revision(): string {
    const state = this.deps.state()
    const handOffs = this.rows().flatMap((row) =>
      row.state === 'dispatched' ? [effectiveQueuedCard(row, state).state] : []
    )
    return `${this.tableRevision()}:${handOffs.join()}`
  }

  /** Cached per revision: the drain re-checks on every journal publish, so an unchanged table
   *  must cost no SQL read or body parse on token streams. */
  cards(): readonly QueuedMessageRow[] {
    const key = this.revision()
    if (this.viewed?.key !== key) {
      const state = this.deps.state()
      this.viewed = { key, cards: this.rows().map((row) => effectiveQueuedCard(row, state)) }
    }
    return this.viewed.cards
  }

  card(messageId: string): QueuedMessageRow | null {
    const row = getQueuedMessage(this.deps.database().db, this.deps.sessionId, messageId)
    return row && effectiveQueuedCard(row, this.deps.state())
  }

  /** Inside a transaction: read from `db`, never cached under state a rollback could undo. */
  cardsIn(db: Database.Database): QueuedMessageRow[] {
    const state = this.deps.state()
    return listQueuedMessages(db, this.deps.sessionId).map((row) => effectiveQueuedCard(row, state))
  }

  /** An action first stores its own cards as readers see them, so its compare-and-set matches what
   *  the person acted on; only its own, so another card's failed bookkeeping never blocks it.
   *  Returns how many changed. */
  store(db: Database.Database, messageIds: readonly string[]): number {
    const { sessionId } = this.deps
    const state = this.deps.state()
    return writeEffectiveQueuedCards(db, { sessionId, now: this.deps.now(), messageIds }, (row) =>
      effectiveQueuedCard(row, state)
    )
  }

  /** Some stored row is not the card readers see: its durable copy is still unwritten. */
  storedBehind(): boolean {
    const cards = this.cards()
    return this.rows().some((row, index) => row !== cards[index])
  }

  private rows(): readonly QueuedMessageRow[] {
    const revision = this.tableRevision()
    if (this.stored?.revision !== revision) {
      this.stored = {
        revision,
        rows: listQueuedMessages(this.deps.database().db, this.deps.sessionId)
      }
    }
    return this.stored.rows
  }
}

/** The one writer of a refused hand-off's card: stores `effective`'s answer wherever it differs
 *  from the stored row, matched on that row's hand-off. `messageIds` limits it to an action's own
 *  cards. Returns how many cards changed. */
export function writeEffectiveQueuedCards(
  db: Database.Database,
  input: { sessionId: string; now: number; messageIds?: readonly string[] },
  effective: (row: QueuedMessageRow) => QueuedMessageRow
): number {
  const rows = input.messageIds
    ? input.messageIds.flatMap((id) => getQueuedMessage(db, input.sessionId, id) ?? [])
    : listQueuedMessages(db, input.sessionId)
  const write = db.prepare(
    `UPDATE queued_messages
     SET state = ?, hold_reason = ?, consumed_as = ?, returned_reason = ?, returned_rejection = ?,
         settled_at = ?, settled_by_op = ?
     WHERE session_id = ? AND message_id = ? AND state = 'dispatched' AND consumed_as = ?`
  )
  let written = 0
  for (const row of rows) {
    const card = effective(row)
    if (card === row) {
      continue
    }
    const changed = write.run(
      card.state,
      card.holdReason,
      card.consumedAs,
      card.returnedReason,
      card.returnedRejection ? JSON.stringify(card.returnedRejection) : null,
      card.state === 'waiting' ? null : input.now,
      card.settledByOp,
      input.sessionId,
      row.messageId,
      row.consumedAs
    )
    written += Number(changed.changes ?? 0)
  }
  return written
}
