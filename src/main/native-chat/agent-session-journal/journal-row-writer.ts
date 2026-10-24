import { isDeepStrictEqual } from 'node:util'
import { stageJournalMutation } from './journal-mutation-stage'
import type { JournalReducerState } from './journal-reducer'
import type Database from '../../sqlite/sync-database'
import { insertJournalRow, writeJournalRestFact } from './journal-row-table'
import type { JournalHostDatabase } from './journal-host-database'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from './journal-write-queue'

/** Write receipts in the row transaction; notify synchronously after COMMIT, never rollback. */
export type JournalOperationReceipt = {
  write: (db: Database.Database, row?: JournalRow) => void
  committed: () => void
}

export function composeJournalOperationReceipts(
  ...receipts: JournalOperationReceipt[]
): JournalOperationReceipt {
  return {
    write: (db, row) => receipts.forEach((receipt) => receipt.write(db, row)),
    committed: () => receipts.forEach((receipt) => receipt.committed())
  }
}

export function writeReceiptIfChanged<T>(
  run: (db: Database.Database) => T,
  changed: (result: T) => boolean,
  receipt?: JournalOperationReceipt
): (db: Database.Database) => T {
  return (db) => {
    const result = run(db)
    if (receipt && changed(result)) {
      receipt.write(db)
    }
    return result
  }
}

export type JournalRowWriterDeps = {
  state?: () => JournalReducerState
  sessionId: string
  now: () => number
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  highestFence: () => number
  nextSequence: () => number
  commit: (rows: readonly JournalRow[], savedAt: number) => void
  /** Streamed-text-only revisions may skip per-commit fsync; settlement makes them durable. */
  streamedTextRevision?: (row: JournalRow) => boolean
}

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(
    build: (seq: number, ts: number) => JournalRow,
    receipt?: JournalOperationReceipt
  ): Promise<JournalRow> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const savedAt = this.deps.now()
      const row = build(this.deps.nextSequence(), savedAt)
      assertJournalFence(row.fence, this.deps.highestFence())
      const fact = this.prepareFact([row])
      // One INSERT: the chat's epoch pointer moves only when the epoch does.
      this.deps.database().transaction(
        (db) => {
          insertJournalRow(db, this.deps.sessionId, row, savedAt)
          if (fact !== undefined) {
            writeJournalRestFact(db, this.deps.sessionId, fact)
          }
          receipt?.write(db, row)
        },
        fact === undefined && !receipt && this.streamed([row])
      )
      // COMMIT landed, so the row is durable: adopt it before anything that can
      // fail. Rejecting here instead would leave the next append reusing a
      // sequence the table already holds. The ledger first: it cannot throw, the fold can.
      this.rememberFact(fact)
      receipt?.committed()
      this.deps.commit([row], savedAt)
      return row
    })
  }

  /** Plan on the write lane and commit all rows atomically; receiptRow identifies the receipt target. */
  enqueueRows(
    plan: () => readonly ((seq: number, ts: number) => JournalRow)[],
    receipt?: JournalOperationReceipt,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): Promise<JournalRow[]> {
    return this.deps.serialize(() => this.writeRows(plan, receipt, receiptRow))
  }

  /** Caller must already own the write lane. */
  writeRows(
    plan: () => readonly ((seq: number, ts: number) => JournalRow)[],
    receipt?: JournalOperationReceipt,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): JournalRow[] {
    assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
    const first = this.deps.nextSequence()
    const ts = this.deps.now()
    const rows = plan().map((build, index) => build(first + index, ts))
    if (rows.length === 0) {
      return rows
    }
    for (const row of rows) {
      assertJournalFence(row.fence, this.deps.highestFence())
    }
    const fact = this.prepareFact(rows)
    this.deps.database().transaction(
      (db) => {
        for (const row of rows) {
          insertJournalRow(db, this.deps.sessionId, row, ts)
        }
        if (fact !== undefined) {
          writeJournalRestFact(db, this.deps.sessionId, fact)
        }
        receipt?.write(db, receiptRow?.(rows))
      },
      fact === undefined && !receipt && this.streamed(rows)
    )
    this.rememberFact(fact)
    receipt?.committed()
    this.deps.commit(rows, ts)
    return rows
  }

  /** Serialize sequence assignment, durable write and replay-equivalent folding. */
  append(
    build: (seq: number, ts: number) => JournalRow,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    return this.enqueue(build, receipt).then((row) => ({
      epoch: row.epoch,
      sequence: row.seq
    }))
  }

  private prepareFact(rows: readonly JournalRow[]) {
    const state = this.deps.state?.()
    if (!state) {
      return undefined
    }
    const next = this.streamed(rows) ? state : stageJournalMutation(state, rows)
    const fact = next.rest.fact()
    return isDeepStrictEqual(state.persistedRest, [fact?.itemId ?? null, fact?.since ?? 0])
      ? undefined
      : fact
  }

  private rememberFact(fact: ReturnType<JournalRowWriter['prepareFact']>): void {
    if (fact !== undefined && this.deps.state) {
      this.deps.state().persistedRest = [fact?.itemId ?? null, fact?.since ?? 0]
    }
  }

  async synchronizeRestFact(): Promise<void> {
    try {
      await this.deps.serialize(() => {
        const state = this.deps.state?.()
        if (!state || this.deps.readOnly() || state.persistedRest?.[1] !== null) {
          return
        }
        const fact = state.rest.fact()
        const pair = [fact?.itemId ?? null, fact?.since ?? 0] as const
        if (isDeepStrictEqual(state.persistedRest, pair)) {
          return
        }
        this.deps.database().transaction((db) => {
          const result = db
            .prepare(`UPDATE journal_sessions SET open_turn_id = ?, open_turn_since = ?
            WHERE session_id = ? AND epoch = ? AND open_turn_id IS ? AND open_turn_since IS ?
            AND (SELECT MAX(seq) FROM journal_rows WHERE session_id = journal_sessions.session_id AND epoch = journal_sessions.epoch) = ?`)
            .run(
              ...pair,
              this.deps.sessionId,
              state.epoch,
              ...(state.persistedRest ?? [null, null]),
              state.lastSequence
            )
          if (result.changes !== 1) {
            throw new Error('journal projection changed during open')
          }
        })
        this.rememberFact(fact)
      })
    } catch (error) {
      console.warn(
        '[journal-open] rest projection synchronization failed',
        this.deps.sessionId,
        error
      )
    }
  }

  private streamed(rows: readonly JournalRow[]): boolean {
    const { streamedTextRevision } = this.deps
    return streamedTextRevision !== undefined && rows.every((row) => streamedTextRevision(row))
  }
}
