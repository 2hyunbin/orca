import { JOURNAL_STRUCTURAL_SCRATCH_FORMAT } from './journal-structural-scratch-encoding'
import type Database from '../../sqlite/sync-database'
import { readJournalSessionProjection } from './journal-row-table'
import { replayLegacyRestChunk } from './journal-legacy-rest-replay'
import { LegacyRestScratch } from './journal-legacy-rest-scratch'
import type { JournalStructuralCheckpoint } from './journal-structural-scratch'
import type {
  LegacyRestRequest,
  LegacyRestResponse,
  LegacyRestSource
} from './journal-legacy-rest-worker-protocol'

/** Same executor in the thread and statement-meter proofs; production never runs it on main. */
export class LegacyRestReplay {
  private readonly scratch: LegacyRestScratch
  constructor(
    private readonly db: Database.Database,
    directory: string
  ) {
    this.scratch = new LegacyRestScratch(directory)
  }

  grant(request: LegacyRestRequest, canWork: () => boolean, setupMs = 0): LegacyRestResponse {
    const started = performance.now() - setupMs
    let result: LegacyRestResponse = {
      ...request,
      guard: request.source?.guard ?? '',
      status: 'paused',
      cursor: 0,
      pending: false,
      occupiedMs: 0
    }
    try {
      for (let chunk = 0; chunk < 4 && performance.now() - started < 32 && canWork(); chunk++) {
        if (request.mode === 'discover') {
          const candidate = this.scratch.discover()
          result.status =
            candidate === null ? 'exhausted' : candidate === undefined ? 'progress' : 'found'
          result.candidate = candidate ?? undefined
          break
        }
        const { sessionId, source } = request
        if (request.mode === 'replay' && (!source || !this.matches(sessionId, source, canWork))) {
          result.status = 'drift'
          break
        }
        if (!canWork() || performance.now() - started >= 32) {
          break
        }
        const scratch = this.scratch.open(sessionId, request.mode === 'replay')
        if (!scratch) {
          result.status = 'clean'
          break
        }
        const saved = scratch.load<JournalStructuralCheckpoint & { cleanup?: boolean }>()
        result.cursor = saved?.cursor ?? 0
        result.pending = !!saved?.pending
        if (!canWork() || performance.now() - started >= 32) {
          break
        }
        if (
          request.mode === 'cleanup' ||
          saved?.cleanup ||
          (saved &&
            (saved.guard !== source?.guard ||
              saved.selection?.format !== JOURNAL_STRUCTURAL_SCRATCH_FORMAT))
        ) {
          const chunkStarted = performance.now()
          scratch.db.exec('BEGIN IMMEDIATE')
          try {
            if (!saved?.cleanup) {
              scratch.beginCleanup(sessionId)
            }
            const clean = scratch.cleanupStep(
              32,
              () => canWork() && performance.now() - chunkStarted < 8
            )
            scratch.db.exec('COMMIT')
            result.status = clean ? 'clean' : 'progress'
          } catch (error) {
            scratch.db.exec('ROLLBACK')
            throw error
          }
          if (result.status === 'clean') {
            break
          }
          continue
        }
        if (!source || !canWork()) {
          break
        }
        const step = replayLegacyRestChunk(this.db, scratch, sessionId, source, canWork)
        result = { ...result, ...step, status: step.finished ? 'complete' : 'progress' }
        if (step.finished) {
          break
        }
      }
      if (!canWork() && result.status === 'progress') {
        result.status = 'paused'
      }
    } catch (error) {
      result.status = 'failed'
      result.error = error instanceof Error ? error.message : String(error)
    }
    result.occupiedMs = performance.now() - started
    return result
  }

  close(): void {
    this.scratch.close()
  }

  private matches(id: string, source: LegacyRestSource, canWork: () => boolean): boolean {
    const projection = readJournalSessionProjection(this.db, id)
    if (
      !projection ||
      projection.epoch !== source.epoch ||
      projection.pair[0] !== source.pair[0] ||
      projection.pair[1] !== source.pair[1]
    ) {
      return false
    }
    if (!canWork()) {
      return false
    }
    const tip =
      this.db
        .prepare('SELECT MAX(seq) AS tip FROM journal_rows WHERE session_id = ? AND epoch = ?')
        .get(id, source.epoch)?.tip ?? 0
    return tip === source.tip
  }
}
