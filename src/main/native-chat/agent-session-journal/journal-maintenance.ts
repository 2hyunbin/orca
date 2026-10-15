import type Database from "../../sqlite/sync-database";
import {
  JOURNAL_BUSY_TIMEOUT_MS,
  journalPragmaNumber,
} from "./journal-database";
import { JournalPrunePass } from "./journal-prune-pass";

const QUIET_DELAY_MS = 30_000;
const PASS_DELAY_MS = 10;
const VACUUM_PAGES = 1;

/** One host-owned, finite sweep; writes wake it again after it has drained. */
export class JournalMaintenance {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly dirty = new Map<string, number>();
  private sessionAfter = "";
  private sweeping = true;
  private current: JournalPrunePass | null = null;
  private closed = false;
  private vacuumPending = true;

  constructor(
    private readonly database: () => Database.Database,
    initialDelayMs = QUIET_DELAY_MS,
  ) {
    this.schedule(initialDelayMs);
  }

  appended(sessionId: string): void {
    if (this.closed) {
      return;
    }
    this.vacuumPending = true;
    if (this.dirty.has(sessionId)) {
      this.schedule(QUIET_DELAY_MS);
      return;
    }
    if (this.dirty.size < 1_024) {
      this.dirty.set(sessionId, Date.now() + QUIET_DELAY_MS);
    } else {
      this.sweeping = true;
      this.sessionAfter = "";
    }
    this.schedule(QUIET_DELAY_MS);
  }

  changed(): void {
    this.vacuumPending = true;
    this.schedule(QUIET_DELAY_MS);
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = null;
    this.current = null;
    this.dirty.clear();
  }

  private schedule(delay: number): void {
    if (this.timer || this.closed) {
      return;
    }
    this.timer = setTimeout(() => this.advance(), delay);
    this.timer.unref();
  }

  private advance(): void {
    this.timer = null;
    try {
      this.step(this.database());
      if (this.current || this.sweeping || this.vacuumPending) {
        this.schedule(PASS_DELAY_MS);
      } else if (this.dirty.size > 0) {
        this.schedule(
          Math.max(
            PASS_DELAY_MS,
            Math.min(...this.dirty.values()) - Date.now(),
          ),
        );
      }
    } catch (error) {
      // A later append or restart re-derives the work; a failing sweep has no retry loop.
      this.current = null;
      this.sweeping = false;
      this.vacuumPending = false;
      this.dirty.clear();
      console.warn("[journal-maintenance] stopped:", error);
    }
  }

  private step(db: Database.Database): void {
    // Maintenance never waits for a competing writer on the interaction thread.
    db.pragma("busy_timeout = 0");
    try {
      if (this.current === null) {
        this.current = this.nextSession(db);
      }
      if (this.current !== null) {
        if (this.current.step(db).done) {
          this.current = null;
        }
      } else if (this.vacuumPending) {
        this.vacuumPending = this.reclaim(db);
      }
    } finally {
      db.pragma(`busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`);
    }
  }

  private nextSession(db: Database.Database): JournalPrunePass | null {
    if (this.sweeping) {
      const row = db
        .prepare(
          `SELECT session_id, epoch FROM journal_sessions
WHERE session_id > ? ORDER BY session_id LIMIT 1`,
        )
        .get(this.sessionAfter);
      if (
        typeof row?.session_id === "string" &&
        typeof row.epoch === "string"
      ) {
        this.sessionAfter = row.session_id;
        this.dirty.delete(row.session_id);
        return new JournalPrunePass(db, row.session_id, row.epoch);
      }
      this.sweeping = false;
    }
    const ready = [...this.dirty].find(([, at]) => at <= Date.now());
    const sessionId = ready?.[0];
    if (sessionId === undefined) {
      return null;
    }
    this.dirty.delete(sessionId);
    const row = db
      .prepare("SELECT epoch FROM journal_sessions WHERE session_id = ?")
      .get(sessionId);
    return typeof row?.epoch === "string"
      ? new JournalPrunePass(db, sessionId, row.epoch)
      : null;
  }

  private reclaim(db: Database.Database): boolean {
    if (journalPragmaNumber(db, "auto_vacuum") !== 2) {
      return false;
    }
    const before = journalPragmaNumber(db, "freelist_count");
    if (before === 0) {
      return false;
    }
    db.pragma(`incremental_vacuum(${VACUUM_PAGES})`);
    const after = journalPragmaNumber(db, "freelist_count");
    return after > 0 && after < before;
  }
}
