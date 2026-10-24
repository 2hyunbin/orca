import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { setImmediate as yieldToForeground } from 'node:timers/promises'
import { stepStructuralJournalRow } from './journal-structural-fold-step'
import { parseJournalRow } from './journal-row-schema'
import {
  readJournalRestFacts,
  readJournalRowsAfter,
  readJournalSessionProjection
} from './journal-row-table'
import type { JournalHostDatabase } from './journal-host-database'
import {
  JournalStructuralScratch,
  structuralJournalState,
  type JournalStructuralCheckpoint
} from './journal-structural-scratch'

/** One first-upgrade candidate, resumed from atomically saved derived relations and cursor. */
export class JournalLegacyRestInitializer {
  private scratch?: JournalStructuralScratch
  private running: Promise<void> | undefined
  private stopped = false
  private readonly attempted = new Set<string>()
  private discovery?: Iterator<string | undefined>
  private readonly reconsidered = new Set<string>()
  private candidate?: string
  constructor(
    private readonly deps: {
      database: JournalHostDatabase
      candidates: () => Iterable<string | undefined>
      /** Ordinary open can commit the pair before its cold unknown presentation completes. */
      needsPublication?: (sessionId: string) => boolean
      /** Null means an owner is still live/foreign/unproved; a stable value is its actual source guard. */
      owner: (sessionId: string) => string | null
      initialized: (
        sessionId: string,
        facts: NonNullable<ReturnType<typeof readJournalRestFacts>>
      ) => void
      failed: (sessionId: string, error: unknown) => void
    }
  ) {}

  /** Existing committed owner proof can make a formerly foreign candidate eligible. */
  reconsider(sessionId: string): void {
    this.reconsidered.add(sessionId)
  }

  advance(canWork: () => boolean): Promise<void> | undefined {
    if (this.running || this.stopped || this.deps.database.readOnly || !canWork()) {
      return
    }
    this.running = this.run(canWork)
      .catch((error: unknown) => this.deps.failed('', error))
      .finally(() => {
        this.running = undefined
        if (this.stopped) {
          this.scratch?.close()
          this.scratch = undefined
        }
      })
    return this.running
  }
  close(): void {
    this.stopped = true
    if (!this.running) {
      this.scratch?.close()
      this.scratch = undefined
    }
  }
  private source(sessionId: string) {
    const { db } = this.deps.database
    const projection = readJournalSessionProjection(db, sessionId)
    const owner = this.deps.owner(sessionId)
    if (!projection || owner === null) {
      return null
    }
    const known = projection.pair[0] !== null || projection.pair[1] === 0
    if (
      known
        ? !this.deps.needsPublication?.(sessionId)
        : projection.pair[0] !== null || projection.pair[1] !== null
    ) {
      return null
    }
    const tip = Number(
      db
        .prepare('SELECT MAX(seq) AS tip FROM journal_rows WHERE session_id = ? AND epoch = ?')
        .get(sessionId, projection.epoch)?.tip ?? 0
    )
    if (tip < 1) {
      return null
    }
    return {
      ...projection,
      known,
      tip,
      guard: JSON.stringify([6, sessionId, projection, tip, owner])
    }
  }
  private publishKnown(sessionId: string, guard: string): void {
    const facts = readJournalRestFacts(this.deps.database.db, sessionId)
    if (facts?.known && this.source(sessionId)?.guard === guard) {
      this.deps.initialized(sessionId, facts)
    }
    if (this.scratch?.load<JournalStructuralCheckpoint>()?.sessionId === sessionId) {
      this.scratch.beginCleanup(sessionId)
    }
  }
  private async run(canWork: () => boolean): Promise<void> {
    await yieldToForeground()
    if (this.stopped || !canWork()) {
      return
    }
    const scratch = (this.scratch ??= new JournalStructuralScratch(
      join(this.deps.database.stateDirectory, 'journal-rest-upgrade-scratch.db')
    ))
    if (!this.discovery) {
      this.discovery = this.deps.candidates()[Symbol.iterator]()
      this.candidate = scratch.load<JournalStructuralCheckpoint>()?.sessionId
    }
    let examined = 0
    while (!this.stopped) {
      if (examined++ === 32) {
        examined = 1
        await yieldToForeground()
      }
      if (!canWork()) {
        return
      }
      const cleanup = scratch.load<{ cleanup?: boolean; sessionId: string }>()
      if (cleanup?.cleanup) {
        scratch.db.exec('BEGIN IMMEDIATE')
        try {
          scratch.cleanupStep()
          scratch.db.exec('COMMIT')
        } catch (error) {
          scratch.db.exec('ROLLBACK')
          throw error
        }
        await yieldToForeground()
        continue
      }
      if (!this.candidate) {
        const retry = this.reconsidered.values().next()
        if (!retry.done) {
          this.reconsidered.delete(retry.value)
          this.candidate = retry.value
        } else {
          const next = this.discovery.next()
          if (next.done) {
            return
          }
          this.candidate = next.value
        }
      }
      const sessionId = this.candidate
      if (sessionId === undefined) {
        continue
      }
      const source = this.source(sessionId)
      if (!source || this.attempted.has(source.guard)) {
        if (!source && scratch.load<JournalStructuralCheckpoint>()?.sessionId === sessionId) {
          scratch.beginCleanup(sessionId)
        }
        this.candidate = undefined
        continue
      }
      if (source.known) {
        this.publishKnown(sessionId, source.guard)
        this.candidate = undefined
        continue
      }
      let saved = scratch.load<JournalStructuralCheckpoint>()
      if (saved && (saved.guard !== source.guard || saved.selection?.format !== 6)) {
        scratch.beginCleanup(sessionId)
        continue
      }
      const state = structuralJournalState(scratch, sessionId, source.epoch, saved)
      let completed = saved?.cursor ?? 0
      let pending = saved?.pending
      try {
        while (!this.stopped) {
          await yieldToForeground()
          if (this.stopped || !canWork()) {
            return
          }
          const current = this.source(sessionId)
          if (current?.guard !== source.guard) {
            if (current?.known) {
              this.publishKnown(sessionId, current.guard)
            }
            return
          }
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
                entry = readJournalRowsAfter(
                  this.deps.database.db,
                  sessionId,
                  source.epoch,
                  completed,
                  1
                )[0]
                if (!entry || entry.seq > source.tip) {
                  finished = true
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
                sourceHash = createHash('sha256').update(entry.rowJson).digest('hex')
                row = parsed.row
                bytes += Buffer.byteLength(entry.rowJson)
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
              selection: state.selection.checkpoint(),
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
          if (!finished) {
            continue
          }
          const fact = state.rest.fact()
          const committed = this.deps.database.transaction((db) => {
            if (this.source(sessionId)?.guard !== source.guard) {
              return false
            }
            const result = db
              .prepare(`UPDATE journal_sessions SET open_turn_id = ?, open_turn_since = ?
              WHERE session_id = ? AND epoch = ? AND open_turn_id IS NULL AND open_turn_since IS NULL
              AND (SELECT COALESCE(MAX(seq),0) FROM journal_rows WHERE session_id = ? AND epoch = ?) = ?`)
              .run(
                fact?.itemId ?? null,
                fact?.since ?? 0,
                sessionId,
                source.epoch,
                sessionId,
                source.epoch,
                source.tip
              )
            if (result.changes !== 1) {
              throw new Error('legacy projection CAS did not initialize its candidate')
            }
            return true
          })
          if (committed) {
            const facts = readJournalRestFacts(this.deps.database.db, sessionId)
            if (facts) {
              this.deps.initialized(sessionId, facts)
            }
          }
          this.attempted.add(source.guard)
          scratch.beginCleanup(sessionId)
          break
        }
      } catch (error) {
        this.attempted.add(source.guard)
        this.deps.failed(sessionId, error)
      }
      this.candidate = undefined
      if (this.stopped) {
        return
      }
    }
  }
}
