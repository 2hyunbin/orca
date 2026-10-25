import { JOURNAL_STRUCTURAL_SCRATCH_FORMAT } from './journal-structural-scratch-encoding'
import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { stepStructuralJournalRow } from './journal-structural-fold-step'
import { parseJournalRow } from './journal-row-schema'
import { readJournalRowsAfter } from './journal-row-table'
import {
  structuralJournalState,
  type JournalStructuralScratch,
  type JournalStructuralCheckpoint
} from './journal-structural-scratch'
import type { LegacyRestSource } from './journal-legacy-rest-worker-protocol'

/** The existing transaction boundary; no parsed row or source snapshot survives a chunk. */
export function replayLegacyRestChunk(
  db: Database.Database,
  scratch: JournalStructuralScratch,
  sessionId: string,
  source: LegacyRestSource,
  canWork: () => boolean
) {
  const saved = scratch.load<JournalStructuralCheckpoint>()
  const state = structuralJournalState(scratch, sessionId, source.epoch, saved)
  let completed = saved?.cursor ?? 0
  let pending = saved?.pending
  const started = performance.now()
  let bytes = 0
  let rows = 0
  let finished = false
  scratch.db.exec('BEGIN IMMEDIATE')
  try {
    let steps = 0
    let entry: ReturnType<typeof readJournalRowsAfter>[number] | undefined
    let sourceHash: string | undefined
    let row: Extract<ReturnType<typeof parseJournalRow>, { ok: true }>['row'] | undefined
    while (
      rows < 32 &&
      steps < 32 &&
      bytes < 256 * 1024 &&
      performance.now() - started < 8 &&
      canWork()
    ) {
      if (!entry || !row) {
        entry = readJournalRowsAfter(db, sessionId, source.epoch, completed, 1)[0]
        if (!entry || entry.seq > source.tip) {
          finished = true
          break
        }
        if (!canWork()) {
          break
        }
        const parsed = parseJournalRow(entry.rowJson)
        if (
          !parsed.ok ||
          parsed.row.epoch !== source.epoch ||
          parsed.row.seq !== entry.seq ||
          entry.seq !== completed + 1 ||
          (entry.seq === 1 && parsed.row.kind !== 'epoch') ||
          (pending && pending.sequence !== entry.seq)
        ) {
          throw new Error('legacy journal is incomplete, damaged or newer')
        }
        if (!canWork()) {
          break
        }
        sourceHash = createHash('sha256').update(entry.rowJson).digest('hex')
        row = parsed.row
        bytes += Buffer.byteLength(entry.rowJson)
      }
      if (!canWork()) {
        break
      }
      pending = stepStructuralJournalRow(state, row, entry.ts, sourceHash!, pending)
      steps++
      if (!pending) {
        completed = entry.seq
        rows++
        entry = undefined
        row = undefined
      }
    }
    scratch.save({
      sessionId,
      guard: source.guard,
      cursor: completed,
      pending,
      selection: { format: JOURNAL_STRUCTURAL_SCRATCH_FORMAT },
      agent: state.agent,
      rest: state.rest.checkpoint(),
      scope: state.derivedTurnScope.checkpoint(),
      latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
      queueRevision: state.queue.revision
    } satisfies JournalStructuralCheckpoint)
    scratch.db.exec('COMMIT')
  } catch (error) {
    scratch.db.exec('ROLLBACK')
    throw error
  }
  return {
    cursor: completed,
    pending: !!pending,
    finished,
    fact: finished ? state.rest.fact() : undefined
  }
}
