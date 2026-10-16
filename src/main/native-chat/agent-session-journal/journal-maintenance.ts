import type Database from '../../sqlite/sync-database'
import { journalPragmaNumber, type JournalTransaction } from './journal-database'
import { JournalPrunePass } from './journal-prune-pass'
import {
  collectJournalPruneGarbage,
  JournalPruneRefusal,
  readOwedJournalPruneEpochs
} from './journal-prune-state'

const QUIET_DELAY_MS = 30_000
const PASS_DELAY_MS = 10
const VACUUM_PAGES = 1

/** Owed work is derived from saved frontiers, so a restart resumes instead of rescanning. */
export class JournalMaintenance {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Round-robin position: a chat that finishes a pass waits behind every other owed chat. */
  private sessionAfter = ''
  /** Scheduling only, not an obligation: a chat still streaming waits until it has been quiet. */
  private readonly quietUntil = new Map<string, number>()
  private current: JournalPrunePass | null = null
  private closed = false
  private vacuumPending = true
  private garbageTurn = true
  private idle = false

  constructor(
    private readonly database: () => Database.Database,
    private readonly transaction: JournalTransaction,
    initialDelayMs = QUIET_DELAY_MS
  ) {
    this.schedule(initialDelayMs)
  }

  appended(sessionId: string): void {
    if (this.closed) {
      return
    }
    this.quietUntil.set(sessionId, Date.now() + QUIET_DELAY_MS)
    this.changed()
  }

  changed(): void {
    this.vacuumPending = true
    this.idle = false
    this.schedule(QUIET_DELAY_MS)
  }

  close(): void {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.current = null
  }

  private stop(error: unknown): void {
    this.close()
    console.warn('[journal-maintenance] stopped:', error)
  }

  private schedule(delay: number): void {
    if (this.timer || this.closed) {
      return
    }
    this.timer = setTimeout(() => this.advance(), delay)
    this.timer.unref()
  }

  private advance(): void {
    this.timer = null
    try {
      const db = this.database()
      const collected = this.garbageTurn && collectJournalPruneGarbage(db, this.transaction)
      this.garbageTurn = !this.garbageTurn
      if (!collected) {
        this.step(db)
      }
      // Idle still collects retired bookkeeping before sleeping, so every leftover can die.
      if (
        collected ||
        this.current ||
        !this.idle ||
        this.vacuumPending ||
        collectJournalPruneGarbage(db, this.transaction)
      ) {
        this.schedule(PASS_DELAY_MS)
        return
      }
      const now = Date.now()
      const waking = [...this.quietUntil.values()].filter((at) => at > now)
      if (waking.length > 0) {
        this.schedule(Math.max(PASS_DELAY_MS, Math.min(...waking) - now))
      }
    } catch (error) {
      this.stop(error)
    }
  }

  private step(db: Database.Database): void {
    this.current ??= this.nextSession(db)
    const pass = this.current
    if (!pass) {
      if (this.vacuumPending) {
        this.vacuumPending = this.reclaim(db)
      }
      return
    }
    try {
      const result = pass.step(db, this.transaction)
      this.vacuumPending ||= result.compacted > 0
      if (!result.done) {
        return
      }
    } catch (error) {
      if (!(error instanceof JournalPruneRefusal)) {
        throw error
      }
      pass.refuse(this.transaction)
      console.warn('[journal-maintenance] skipped epoch:', {
        sessionId: pass.sessionId,
        epoch: pass.epoch,
        reason: error.message
      })
    }
    this.current = null
  }

  /** The next owed, quiet chat after the round-robin position; marks idle when none is owed. */
  private nextSession(db: Database.Database): JournalPrunePass | null {
    const now = Date.now()
    const owed = readOwedJournalPruneEpochs(db).filter(
      ({ sessionId }) => (this.quietUntil.get(sessionId) ?? 0) <= now
    )
    for (const [sessionId, at] of this.quietUntil) {
      if (at <= now) {
        this.quietUntil.delete(sessionId)
      }
    }
    const next = owed.find(({ sessionId }) => sessionId > this.sessionAfter) ?? owed[0]
    if (!next) {
      this.idle = true
      return null
    }
    this.idle = false
    this.sessionAfter = next.sessionId
    return new JournalPrunePass(db, next.sessionId, next.epoch)
  }

  private reclaim(db: Database.Database): boolean {
    if (journalPragmaNumber(db, 'auto_vacuum') !== 2) {
      return false
    }
    const before = journalPragmaNumber(db, 'freelist_count')
    if (before === 0) {
      return false
    }
    db.pragma(`incremental_vacuum(${VACUUM_PAGES})`)
    const after = journalPragmaNumber(db, 'freelist_count')
    return after > 0 && after < before
  }
}
