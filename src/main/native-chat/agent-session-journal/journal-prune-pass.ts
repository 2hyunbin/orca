import { performance } from 'node:perf_hooks'
import type Database from '../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import { JournalPrunePolicy } from './journal-prune-policy'
import {
  MAX_JOURNAL_LIFECYCLE_BATCH_BYTES,
  parseJournalRow,
  type JournalRow
} from './journal-row-schema'
import { readJournalRowsAfter, readJournalSessionEpoch } from './journal-row-table'

export const JOURNAL_PRUNE_MAX_ROWS = 32
const MAX_PASS_BYTES = 256 * 1024
const PASS_BUDGET_MS = 4

/** One finite epoch scan: validate its frozen prefix before deleting any of it. */
export class JournalPrunePass {
  private after = 0
  private validating = true
  private readonly policy = new JournalPrunePolicy()
  private readonly upper: number

  constructor(
    db: Database.Database,
    readonly sessionId: string,
    readonly epoch: string
  ) {
    const upper = db
      .prepare(`SELECT MAX(seq) AS seq FROM journal_rows
WHERE session_id = ? AND epoch = ?`)
      .get(sessionId, epoch)?.seq
    this.upper = typeof upper === 'number' ? upper : 0
  }

  step(db: Database.Database): { done: boolean; removed: number; scanned: number } {
    if (readJournalSessionEpoch(db, this.sessionId) !== this.epoch) {
      return { done: true, removed: 0, scanned: 0 }
    }
    const started = performance.now()
    let scanned = 0
    let removed = 0
    let bytes = 0
    let done = false
    const run = (): void => {
      while (scanned < JOURNAL_PRUNE_MAX_ROWS && bytes < MAX_PASS_BYTES) {
        const stored = readJournalRowsAfter(db, this.sessionId, this.epoch, this.after, 1)[0]
        if (!stored || stored.seq > this.upper) {
          if (this.validating) {
            this.validating = false
            this.after = 0
          } else {
            done = true
          }
          break
        }
        const parsed = parseJournalRow(stored.rowJson)
        if (!parsed.ok || parsed.row.seq !== stored.seq || parsed.row.epoch !== this.epoch) {
          throw new Error('journal pruning refused an unreadable row')
        }
        const row = parsed.row
        if (this.validating) {
          if (
            (this.after === 0 && (row.seq !== 1 || row.kind !== 'epoch')) ||
            (row.seq !== this.after + 1 && row.previousSequence !== this.after)
          ) {
            throw new Error('journal pruning refused a sequence gap')
          }
        } else {
          const obsolete = this.policy.observe(row, stored.ts)
          if (obsolete !== null) {
            if (removeSupersededRow(db, this.sessionId, this.epoch, obsolete)) {
              removed++
            }
          }
        }
        this.after = stored.seq
        bytes += Buffer.byteLength(stored.rowJson, 'utf8')
        scanned++
        if (performance.now() - started >= PASS_BUDGET_MS) {
          break
        }
      }
    }
    if (this.validating) {
      run()
    } else {
      runJournalTransaction(db, run)
    }
    return { done, removed, scanned }
  }
}

function removeSupersededRow(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  sequence: number
): boolean {
  const before = db
    .prepare(`SELECT seq FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq < ? ORDER BY seq DESC LIMIT 1`)
    .get(sessionId, epoch, sequence)?.seq
  const after = readJournalRowsAfter(db, sessionId, epoch, sequence, 1)[0]
  const parsed = after && parseJournalRow(after.rowJson)
  if (typeof before !== 'number' || !parsed?.ok) {
    throw new Error('journal pruning could not retain its sequence boundary')
  }
  const replacement: JournalRow = { ...parsed.row, previousSequence: before }
  const rowJson = JSON.stringify(replacement)
  if (
    replacement.kind === 'lifecycle-batch' &&
    Buffer.byteLength(rowJson, 'utf8') + 1 > MAX_JOURNAL_LIFECYCLE_BATCH_BYTES
  ) {
    return false
  }
  db.prepare(`UPDATE journal_rows SET row_json = ?
WHERE session_id = ? AND epoch = ? AND seq = ?`).run(rowJson, sessionId, epoch, after.seq)
  db.prepare(`UPDATE journal_rows SET row_json = json_set(row_json, '$.compactedThrough',
MAX(COALESCE(json_extract(row_json, '$.compactedThrough'), 0), ?))
WHERE session_id = ? AND epoch = ? AND seq = 1`).run(sequence, sessionId, epoch)
  db.prepare('DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?').run(
    sessionId,
    epoch,
    sequence
  )
  return true
}
