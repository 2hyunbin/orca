// Bringing the `queued_messages` rows earlier builds wrote into the journal. Those rows are the only
// record of the work this owes, so nothing else stores it: it ends once no readable row is left.
// Until then the queue's one view reads each through the fold's own classification, so a card reads
// the same before and after it moves, and every action on one moves it in its own transaction. The
// bulk import runs once per open and is never retried in a loop: the next open tries again.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import { journalQueueRowBuilder, type JournalQueuedChange } from './journal-queue-events'
import { queuedCardFromChange } from './journal-queue-fold'
import { queuedChangeOf } from './journal-queue-retention'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalQueuedMessagesDeps } from './journal-store-contracts'
import type { QueuedMessageRow } from './queued-message-table'
import {
  LEGACY_QUEUED_MESSAGE_COLUMNS,
  readStoredQueuedMessageRow
} from './queued-message-stored-row'

type LegacyDeps = Pick<
  JournalQueuedMessagesDeps,
  'sessionId' | 'database' | 'state' | 'serialize' | 'readOnly' | 'writer' | 'committed'
>

/** The `queued` change a legacy row moves into the journal as, or null when it is answered and
 *  nothing is written: withdrawn or delivered. Its hand-off link is kept, and its stored refusal
 *  only where that hand-off is not in this epoch. */
export function legacyQueuedChange(
  state: JournalReducerState,
  row: QueuedMessageRow
): JournalQueuedChange | null {
  const attempt = row.state === 'waiting' ? null : row.consumedAs
  if (row.state === 'withdrawn' || (row.state === 'dispatched' && attempt === null)) {
    return null
  }
  const change: JournalQueuedChange = {
    ...queuedChangeOf(row),
    ...(row.state === 'waiting' && row.holdReason !== null ? { holdReason: row.holdReason } : {}),
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

/** Waiting, returned, or handed off as a send a later row may still answer (as the fold keeps it),
 *  or that nothing can answer. */
function unanswered(
  card: QueuedMessageRow,
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): boolean {
  if (card.state !== 'dispatched') {
    return card.state !== 'withdrawn'
  }
  const handOff = card.consumedAs === null ? undefined : submissions.get(card.consumedAs)
  return handOff === undefined || journalDispatchRowApplies(handOff)
}

/** The legacy rows still on disk for one session, as the queue's view reads them. */
export class LegacyQueuedCards {
  /** Moves after every commit that deleted legacy rows. */
  private revision = 0
  private stored: { revision: number; rows: readonly QueuedMessageRow[] } | null = null
  private viewed: { key: string; cards: readonly QueuedMessageRow[] } | null = null

  constructor(private readonly deps: LegacyDeps) {}

  /** Empty once no readable legacy row is left: the fallback is then off for this handle. A card's
   *  reading follows the fold, so it moves with every row while any is left. */
  key(): string {
    if (this.rows().length === 0) {
      return ''
    }
    const { epoch, lastSequence } = this.deps.state()
    return `${this.revision}:${epoch}:${lastSequence}`
  }

  cards(): readonly QueuedMessageRow[] {
    const key = this.key()
    if (key === '') {
      return []
    }
    if (this.viewed?.key !== key) {
      const state = this.deps.state()
      const cards = this.rows().flatMap((row) => {
        const change = legacyQueuedChange(state, row)
        return change ? [queuedCardFromChange(state, row.messageId, change)] : []
      })
      this.viewed = { key, cards }
    }
    return this.viewed.cards
  }

  /** On the journal's lane: the change that moves this card into the journal, read from disk now;
   *  null when it is not a legacy card. */
  adoption(messageId: string): JournalQueuedChange | null {
    if (this.key() === '') {
      return null
    }
    const { db } = this.deps.database()
    const row = db
      .prepare(
        `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? AND message_id = ?`
      )
      .get(this.deps.sessionId, messageId)
    const card = row === undefined ? null : readStoredQueuedMessageRow(row)
    return card && legacyQueuedChange(this.deps.state(), card)
  }

  /** Deletes these legacy rows in the caller's transaction; the view re-reads once it commits. */
  deletion(messageIds: readonly string[]): JournalOperationReceipt {
    return {
      write: (db) => {
        const remove = db.prepare(
          'DELETE FROM queued_messages WHERE session_id = ? AND message_id = ?'
        )
        for (const messageId of messageIds) {
          remove.run(this.deps.sessionId, messageId)
        }
      },
      committed: () => {
        this.revision += messageIds.length > 0 ? 1 : 0
      }
    }
  }

  /** Every readable legacy row's card id. */
  messageIds(): string[] {
    return this.rows().map((row) => row.messageId)
  }

  /** `deletion` of every readable legacy row: a new epoch restates their cards with its own. */
  deletionOfAll(): JournalOperationReceipt {
    return this.deletion(this.messageIds())
  }

  /** Every readable row, unanswered ones as journal rows, all deleted, in ONE transaction; a
   *  failure is reported and leaves both as they were. */
  importAtOpen(): Promise<void> {
    if (this.deps.readOnly() || this.rows().length === 0) {
      return Promise.resolve()
    }
    return this.deps
      .serialize(() => {
        const rows = this.read()
        const deletion = this.deletion(rows.map((row) => row.messageId))
        const plan = rows.flatMap((row) => {
          const change = legacyQueuedChange(this.deps.state(), row)
          return change ? [journalQueueRowBuilder(this.deps.state, row.messageId, change)] : []
        })
        if (plan.length > 0) {
          this.deps.writer.writeRows(() => plan, deletion)
          return
        }
        // No row to write: the writer opens no transaction for none, so the deletes take their own.
        this.deps.database().transaction((db) => deletion.write(db))
        deletion.committed()
        this.deps.committed()
      })
      .catch((error: unknown) => {
        console.warn('[journal-open] queued-message import skipped:', {
          sessionId: this.deps.sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  private rows(): readonly QueuedMessageRow[] {
    if (this.stored?.revision !== this.revision) {
      this.stored = { revision: this.revision, rows: this.read() }
    }
    return this.stored.rows
  }

  private read(): QueuedMessageRow[] {
    return this.deps
      .database()
      .db.prepare(
        `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC`
      )
      .all(this.deps.sessionId)
      .flatMap((row) => readStoredQueuedMessageRow(row) ?? [])
  }
}
