import type Database from '../../sqlite/sync-database'
import { journalPragmaNumber, type JournalTransaction } from './journal-database'
import { JournalPrunePass } from './journal-prune-pass'
import { collectJournalPruneGarbage, JournalPruneRefusal } from './journal-prune-state'
import { readJournalSessionEpoch } from './journal-row-table'

const QUIET_DELAY_MS = 30_000
const PASS_DELAY_MS = 10
const VACUUM_PAGES = 1

/** Host-owned frontiers outlive individual passes; only unread suffixes wake discovery. */
export class JournalMaintenance {
  private timer: ReturnType<typeof setTimeout> | null = null
  private sessionAfter = ''
  private sweeping = true
  private current: JournalPrunePass | null = null
  private closed = false
  private vacuumPending = true
  private garbageTurn = true

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
    try {
      this.database().prepare(`INSERT OR IGNORE INTO temp.journal_prune_pending
(session_id, ready_at) VALUES (?, ?)`).run(sessionId, Date.now() + QUIET_DELAY_MS)
      this.changed()
    } catch (error) {
      // The append already committed; optional cleanup must never reject its acknowledgement.
      this.stop(error)
    }
  }

  changed(): void {
    this.vacuumPending = true
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
      const garbage = db.prepare('SELECT 1 AS pending FROM temp.journal_prune_epochs WHERE garbage = 1 LIMIT 1').get()
      if (this.current || this.sweeping || this.vacuumPending || garbage) {
        this.schedule(PASS_DELAY_MS)
      } else {
        const ready = db.prepare('SELECT ready_at FROM temp.journal_prune_pending ORDER BY ready_at LIMIT 1').get()?.ready_at
        if (typeof ready === 'number') {
          this.schedule(Math.max(PASS_DELAY_MS, ready - Date.now()))
        }
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
        sessionId: pass.sessionId, epoch: pass.epoch, reason: error.message
      })
    }
    const epoch = readJournalSessionEpoch(db, pass.sessionId)
    if (epoch === null || (epoch === pass.epoch && pass.coversPendingRows(db))) {
      db.prepare('DELETE FROM temp.journal_prune_pending WHERE session_id = ?').run(pass.sessionId)
    } else {
      db.prepare(`INSERT INTO temp.journal_prune_pending (session_id, ready_at)
VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET ready_at = excluded.ready_at`)
        .run(pass.sessionId, Date.now() + QUIET_DELAY_MS)
    }
    this.current = null
  }

  private nextSession(db: Database.Database): JournalPrunePass | null {
    if (this.sweeping) {
      const row = db.prepare(`SELECT session_id, epoch FROM journal_sessions
WHERE session_id > ? ORDER BY session_id LIMIT 1`).get(this.sessionAfter)
      if (typeof row?.session_id === 'string' && typeof row.epoch === 'string') {
        this.sessionAfter = row.session_id
        return new JournalPrunePass(db, row.session_id, row.epoch)
      }
      this.sweeping = false
    }
    const row = db.prepare(`SELECT session_id FROM temp.journal_prune_pending
WHERE ready_at <= ? ORDER BY ready_at, session_id LIMIT 1`).get(Date.now())
    if (typeof row?.session_id !== 'string') {
      return null
    }
    const epoch = readJournalSessionEpoch(db, row.session_id)
    if (epoch === null) {
      db.prepare('DELETE FROM temp.journal_prune_pending WHERE session_id = ?').run(row.session_id)
      return null
    }
    return new JournalPrunePass(db, row.session_id, epoch)
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
