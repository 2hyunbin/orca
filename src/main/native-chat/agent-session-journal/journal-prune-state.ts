import type Database from '../../sqlite/sync-database'
import type { JournalTransaction } from './journal-database'
import type { JournalPruneCandidate, JournalPruneCandidates } from './journal-prune-policy'
import { readJournalSessionEpoch } from './journal-row-table'

/** Configure only at writable open: changing temp_store later destroys callers' TEMP objects. */
export function initializeJournalPruneState(db: Database.Database): boolean {
  try {
    const forcedMemory = db
      .prepare('PRAGMA compile_options')
      .all()
      .some((row) => Object.values(row).includes('TEMP_STORE=3'))
    if (forcedMemory) {
      throw new Error('SQLite forces in-memory temporary storage')
    }
    db.pragma('temp_store = FILE')
    if (Number(db.pragma('temp_store', { simple: true })) !== 1) {
      throw new Error('SQLite did not enable file-backed temporary storage')
    }
    db.pragma('temp.cache_size = -2048')
    db.exec(`CREATE TEMP TABLE journal_prune_epochs (
  session_id TEXT NOT NULL, epoch TEXT NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0,
  upper_seq INTEGER NOT NULL, refused INTEGER NOT NULL DEFAULT 0,
  garbage INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_id, epoch)
) WITHOUT ROWID;
CREATE INDEX temp.journal_prune_garbage ON journal_prune_epochs (garbage, session_id, epoch);
CREATE INDEX temp.journal_prune_session ON journal_prune_epochs (session_id, garbage, epoch);
CREATE TEMP TABLE journal_prune_items (
  session_id TEXT NOT NULL, epoch TEXT NOT NULL, item_id TEXT NOT NULL,
  seq INTEGER NOT NULL, revision INTEGER NOT NULL, signature TEXT NOT NULL,
  removable INTEGER NOT NULL, saved_at REAL NOT NULL, observed_at REAL NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id)
) WITHOUT ROWID;
CREATE TEMP TABLE journal_prune_work (
  session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, seq)
) WITHOUT ROWID;
CREATE TEMP TABLE journal_prune_pending (
  session_id TEXT PRIMARY KEY, ready_at REAL NOT NULL
) WITHOUT ROWID;
CREATE INDEX temp.journal_prune_ready ON journal_prune_pending (ready_at, session_id);`)
    return true
  } catch (error) {
    console.warn('[journal-maintenance] disabled:', error)
    return false
  }
}

export class JournalPruneRefusal extends Error {}

export class JournalPruneState implements JournalPruneCandidates {
  constructor(
    private readonly db: Database.Database,
    readonly sessionId: string,
    readonly epoch: string
  ) {}

  initialize(upper: number): void {
    this.db
      .prepare(`UPDATE temp.journal_prune_epochs SET garbage = 1
WHERE session_id = ? AND epoch != ? AND garbage = 0`)
      .run(this.sessionId, this.epoch)
    this.db
      .prepare(`INSERT OR IGNORE INTO temp.journal_prune_epochs
(session_id, epoch, upper_seq) VALUES (?, ?, ?)`)
      .run(this.sessionId, this.epoch, upper)
  }

  progress(): { scanned: number; upper: number; refused: boolean } {
    const row = this.db
      .prepare(`SELECT scanned, upper_seq, refused
FROM temp.journal_prune_epochs WHERE session_id = ? AND epoch = ?`)
      .get(this.sessionId, this.epoch)
    if (
      typeof row?.scanned !== 'number' ||
      typeof row.upper_seq !== 'number' ||
      typeof row.refused !== 'number'
    ) {
      throw new Error('journal pruning lost its temporary frontier')
    }
    return {
      scanned: row.scanned,
      upper: row.upper_seq,
      refused: row.refused === 1
    }
  }

  advance(scanned: number, upper: number): void {
    this.db
      .prepare(`UPDATE temp.journal_prune_epochs
SET scanned = ?, upper_seq = ?
WHERE session_id = ? AND epoch = ?`)
      .run(scanned, upper, this.sessionId, this.epoch)
  }

  abandon(refused = false): void {
    this.db
      .prepare(`UPDATE temp.journal_prune_epochs SET garbage = 1, refused = ?
WHERE session_id = ? AND epoch = ?`)
      .run(Number(refused), this.sessionId, this.epoch)
  }

  get(itemId: string): JournalPruneCandidate | undefined {
    const row = this.db
      .prepare(`SELECT seq, revision, signature, removable, saved_at, observed_at
FROM temp.journal_prune_items WHERE session_id = ? AND epoch = ? AND item_id = ?`)
      .get(this.sessionId, this.epoch, itemId)
    if (!row) {
      return undefined
    }
    if (
      typeof row.seq !== 'number' ||
      typeof row.revision !== 'number' ||
      typeof row.signature !== 'string' ||
      typeof row.removable !== 'number' ||
      typeof row.saved_at !== 'number' ||
      typeof row.observed_at !== 'number'
    ) {
      throw new Error('journal pruning lost its temporary item frontier')
    }
    return {
      seq: row.seq,
      revision: row.revision,
      signature: row.signature,
      removable: row.removable === 1,
      savedAt: row.saved_at,
      observedAt: row.observed_at
    }
  }

  set(itemId: string, candidate: JournalPruneCandidate): void {
    this.db
      .prepare(`INSERT INTO temp.journal_prune_items
(session_id, epoch, item_id, seq, revision, signature, removable, saved_at, observed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, epoch, item_id) DO UPDATE SET
seq = excluded.seq, revision = excluded.revision, signature = excluded.signature,
removable = excluded.removable, saved_at = excluded.saved_at, observed_at = excluded.observed_at`)
      .run(
        this.sessionId,
        this.epoch,
        itemId,
        candidate.seq,
        candidate.revision,
        candidate.signature,
        Number(candidate.removable),
        candidate.savedAt,
        candidate.observedAt
      )
  }

  delete(itemId: string): void {
    this.db
      .prepare(`DELETE FROM temp.journal_prune_items
WHERE session_id = ? AND epoch = ? AND item_id = ?`)
      .run(this.sessionId, this.epoch, itemId)
  }

  enqueue(sequence: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO temp.journal_prune_work
(session_id, epoch, seq) VALUES (?, ?, ?)`)
      .run(this.sessionId, this.epoch, sequence)
  }

  next(): number | null {
    const seq = this.db
      .prepare(`SELECT seq FROM temp.journal_prune_work
WHERE session_id = ? AND epoch = ? ORDER BY seq LIMIT 1`)
      .get(this.sessionId, this.epoch)?.seq
    return typeof seq === 'number' ? seq : null
  }

  consume(sequence: number): void {
    this.db
      .prepare(`DELETE FROM temp.journal_prune_work
WHERE session_id = ? AND epoch = ? AND seq = ?`)
      .run(this.sessionId, this.epoch, sequence)
  }
}

/** One indexed chunk, interleaved with healthy sessions even while their scans are running. */
export function collectJournalPruneGarbage(
  db: Database.Database,
  transaction: JournalTransaction
): boolean {
  const row = db
    .prepare(`SELECT session_id, epoch, refused FROM temp.journal_prune_epochs
WHERE garbage = 1 ORDER BY session_id, epoch LIMIT 1`)
    .get()
  if (typeof row?.session_id !== 'string' || typeof row.epoch !== 'string') {
    return false
  }
  const sessionId = row.session_id
  const epoch = row.epoch
  const keepRefusal = row.refused === 1 && readJournalSessionEpoch(db, sessionId) === epoch
  transaction(() => {
    const items = db
      .prepare(`DELETE FROM temp.journal_prune_items
WHERE session_id = ? AND epoch = ? AND item_id IN (
SELECT item_id FROM temp.journal_prune_items WHERE session_id = ? AND epoch = ? LIMIT 32)`)
      .run(sessionId, epoch, sessionId, epoch)
    if (items.changes > 0) {
      return
    }
    const work = db
      .prepare(`DELETE FROM temp.journal_prune_work
WHERE session_id = ? AND epoch = ? AND seq IN (
SELECT seq FROM temp.journal_prune_work WHERE session_id = ? AND epoch = ? LIMIT 32)`)
      .run(sessionId, epoch, sessionId, epoch)
    if (work.changes > 0) {
      return
    }
    if (keepRefusal) {
      db.prepare(`UPDATE temp.journal_prune_epochs SET garbage = 0
WHERE session_id = ? AND epoch = ?`).run(sessionId, epoch)
    } else {
      db.prepare('DELETE FROM temp.journal_prune_epochs WHERE session_id = ? AND epoch = ?').run(
        sessionId,
        epoch
      )
    }
  }, 'DEFERRED')
  return true
}
