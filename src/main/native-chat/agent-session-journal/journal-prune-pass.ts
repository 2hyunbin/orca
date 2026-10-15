import { performance } from 'node:perf_hooks'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { JournalPrunePolicy } from './journal-prune-policy'
import { parseJournalRow } from './journal-row-schema'
import { readJournalRowsAfter, readJournalSessionEpoch } from './journal-row-table'

export const JOURNAL_PRUNE_MAX_ROWS = 32
const MAX_PASS_BYTES = 256 * 1024
const PASS_BUDGET_MS = 4

/** A finite epoch scan; only a newer durable full snapshot can retire an earlier payload. */
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
      .prepare(
        `SELECT MAX(seq) AS seq FROM journal_rows
WHERE session_id = ? AND epoch = ?`
      )
      .get(sessionId, epoch)?.seq
    this.upper = typeof upper === 'number' ? upper : 0
  }

  step(db: Database.Database): {
    done: boolean
    compacted: number
    scanned: number
  } {
    if (readJournalSessionEpoch(db, this.sessionId) !== this.epoch) {
      return { done: true, compacted: 0, scanned: 0 }
    }
    const started = performance.now()
    let scanned = 0
    let compacted = 0
    let bytes = 0
    let done = false
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
        if ((this.after === 0 && row.kind !== 'epoch') || row.seq !== this.after + 1) {
          throw new Error('journal pruning refused a sequence gap')
        }
      } else {
        const obsolete = this.policy.observe(row, stored.ts)
        if (
          obsolete !== null &&
          shrinkSupersededPayload(db, this.sessionId, this.epoch, obsolete)
        ) {
          compacted++
        }
      }
      this.after = stored.seq
      bytes += Buffer.byteLength(stored.rowJson, 'utf8')
      scanned++
      if (compacted > 0 || performance.now() - started >= PASS_BUDGET_MS) {
        break
      }
    }
    return { done, compacted, scanned }
  }
}

function shrinkSupersededPayload(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  sequence: number
): boolean {
  const stored = readJournalRowsAfter(db, sessionId, epoch, sequence - 1, 1)[0]
  const parsed = stored && parseJournalRow(stored.rowJson)
  if (!parsed?.ok || parsed.row.kind !== 'item' || stored.seq !== sequence) {
    throw new Error('journal pruning could not retain its superseded row')
  }
  const bodyJson = JSON.stringify(compactJournalPayload(parsed.row.body))
  if (Buffer.byteLength(bodyJson) >= Buffer.byteLength(JSON.stringify(parsed.row.body))) {
    return false
  }
  // Preserve every sequence and its attribution so older hosts and cursor readers still fold it.
  const result = db
    .prepare(
      `UPDATE journal_rows SET row_json = json_set(row_json, '$.body', json(?))
WHERE session_id = ? AND epoch = ? AND seq = ? AND row_json = ?`
    )
    .run(bodyJson, sessionId, epoch, sequence, stored.rowJson)
  return result.changes > 0
}

function compactJournalPayload(body: AgentJournalItemBody): AgentJournalItemBody {
  if (body.kind === 'message') {
    return { ...body, blocks: [] }
  }
  if (body.kind === 'tool-call') {
    return {
      ...body,
      input: null,
      output: undefined,
      webSearchResults: undefined
    }
  }
  if (body.kind === 'diff') {
    return { ...body, patch: { ...body.patch, head: '' } }
  }
  if (body.kind === 'turn') {
    return { ...body, contextUsage: undefined }
  }
  if (body.kind === 'status' && body.turnLifecycle) {
    return {
      ...body,
      turnLifecycle: { ...body.turnLifecycle, contextUsage: undefined },
      providerFrame: undefined
    }
  }
  return body
}
