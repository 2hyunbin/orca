import type Database from '../../sqlite/sync-database'

/** Runs inside the schema migration transaction, before its version is published. */
export function ensureJournalTextPieceSchema(db: Database.Database): void {
  const relationType = db.prepare("SELECT type FROM sqlite_master WHERE name = 'journal_rows'").get()?.type
  if (relationType === 'table') {
    db.exec('ALTER TABLE journal_rows RENAME TO journal_rows_data')
    db.exec('ALTER TABLE journal_rows_data ADD COLUMN text_generation TEXT')
    db.exec('ALTER TABLE journal_rows_data ADD COLUMN text_item_id TEXT')
    db.exec('ALTER TABLE journal_rows_data ADD COLUMN text_path TEXT')
  } else if (relationType === 'view') {
    db.exec(`
DROP TRIGGER IF EXISTS journal_rows_compat_insert;
DROP TRIGGER IF EXISTS journal_rows_compat_update;
DROP TRIGGER IF EXISTS journal_rows_compat_delete;
DROP VIEW journal_rows;
`)
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS journal_text_pieces (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  generation TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_seq INTEGER,
  prefix_length INTEGER NOT NULL,
  prefix_units INTEGER NOT NULL,
  text_length INTEGER NOT NULL,
  text_units INTEGER NOT NULL,
  text_digest TEXT NOT NULL,
  suffix TEXT NOT NULL,
  PRIMARY KEY (session_id, epoch, generation, seq)
);
CREATE INDEX IF NOT EXISTS journal_rows_text_item
 ON journal_rows_data(session_id, epoch, text_item_id, seq);
CREATE INDEX IF NOT EXISTS journal_rows_text_generation
 ON journal_rows_data(session_id, epoch, text_generation);
CREATE INDEX IF NOT EXISTS journal_text_piece_parent
 ON journal_text_pieces(session_id, epoch, generation, parent_seq);
CREATE TRIGGER IF NOT EXISTS journal_rows_piece_delete AFTER DELETE ON journal_rows_data
 WHEN OLD.text_generation IS NOT NULL
BEGIN
 DELETE FROM journal_text_pieces
  WHERE session_id = OLD.session_id AND epoch = OLD.epoch AND generation = OLD.text_generation
   AND NOT EXISTS (SELECT 1 FROM journal_rows_data d
    WHERE d.session_id = OLD.session_id AND d.epoch = OLD.epoch
     AND d.text_generation = OLD.text_generation);
END;
CREATE TRIGGER IF NOT EXISTS journal_rows_piece_update AFTER UPDATE OF text_generation ON journal_rows_data
 WHEN OLD.text_generation IS NOT NULL AND OLD.text_generation IS NOT NEW.text_generation
BEGIN
 DELETE FROM journal_text_pieces
  WHERE session_id = OLD.session_id AND epoch = OLD.epoch AND generation = OLD.text_generation
   AND NOT EXISTS (SELECT 1 FROM journal_rows_data d
    WHERE d.session_id = OLD.session_id AND d.epoch = OLD.epoch
     AND d.text_generation = OLD.text_generation);
END;
`)
}
