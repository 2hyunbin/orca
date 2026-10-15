import type Database from '../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'

/** The five-column view lets older hosts read full rows and keep writing ordinary JSON. */
export function ensureJournalTextPieceSchema(db: Database.Database): void {
  if (db.prepare("SELECT type FROM sqlite_master WHERE name = 'journal_rows'").get()?.type === 'view') {
    return
  }
  runJournalTransaction(db, () => {
    if (db.prepare("SELECT type FROM sqlite_master WHERE name = 'journal_rows'").get()?.type === 'table') {
      db.exec('ALTER TABLE journal_rows RENAME TO journal_rows_data')
      db.exec('ALTER TABLE journal_rows_data ADD COLUMN text_generation TEXT')
      db.exec('ALTER TABLE journal_rows_data ADD COLUMN text_item_id TEXT')
      db.exec('ALTER TABLE journal_rows_data ADD COLUMN text_path TEXT')
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
CREATE VIEW journal_rows AS
SELECT d.session_id, d.epoch, d.seq, d.ts,
 CASE WHEN d.text_generation IS NULL THEN d.row_json
 ELSE COALESCE((
   WITH RECURSIVE chain(seq, parent_seq, prefix_length, prefix_units, text_length,
     text_units, suffix, needed, valid) AS (
     SELECT p.seq, p.parent_seq, p.prefix_length, p.prefix_units,
       p.text_length, p.text_units, p.suffix, p.text_length,
       p.seq >= 1 AND p.prefix_length >= 0 AND p.prefix_units >= 0
       AND p.text_units >= p.prefix_units AND p.text_length = p.prefix_length + length(p.suffix)
       AND length(CAST(p.suffix AS BLOB)) = length(p.suffix)
       AND json_valid('"' || p.suffix || '"')
       AND (p.parent_seq IS NOT NULL OR (p.prefix_length = 0 AND p.prefix_units = 0))
      FROM journal_text_pieces p
      WHERE p.session_id = d.session_id AND p.epoch = d.epoch
       AND p.generation = d.text_generation AND p.seq = d.seq
     UNION ALL
     SELECT parent.seq, parent.parent_seq, parent.prefix_length, parent.prefix_units,
       parent.text_length, parent.text_units, parent.suffix, min(child.needed, child.prefix_length),
       child.valid AND parent.seq >= 1 AND parent.prefix_length >= 0 AND parent.prefix_units >= 0
       AND parent.text_units >= parent.prefix_units
       AND parent.text_length = parent.prefix_length + length(parent.suffix)
       AND length(CAST(parent.suffix AS BLOB)) = length(parent.suffix)
       AND json_valid('"' || parent.suffix || '"')
       AND child.prefix_length <= parent.text_length AND child.prefix_units <= parent.text_units
       AND (parent.parent_seq IS NOT NULL OR (parent.prefix_length = 0 AND parent.prefix_units = 0))
      FROM chain child JOIN journal_text_pieces parent
       ON parent.session_id = d.session_id AND parent.epoch = d.epoch
        AND parent.generation = d.text_generation AND parent.seq = child.parent_seq
        AND parent.seq < child.seq
   )
   SELECT json_set(d.row_json,
     CASE d.text_path
       WHEN 'message' THEN '$.body.blocks[0].text'
       WHEN 'tool-output' THEN '$.body.output.head'
       WHEN 'diff-patch' THEN '$.body.patch.head'
       WHEN 'status' THEN '$.body.text'
     END, json('"' || (SELECT group_concat(fragment, '') FROM (
       SELECT substr(suffix, 1, max(0, needed - prefix_length)) AS fragment
        FROM chain ORDER BY seq
     )) || '"'))
    WHERE json_valid(d.row_json) AND d.text_path IN ('message', 'tool-output', 'diff-patch', 'status')
      AND EXISTS (SELECT 1 FROM chain WHERE parent_seq IS NULL AND valid)
      AND NOT EXISTS (SELECT 1 FROM chain WHERE NOT valid
        OR NOT json_valid('"' || substr(suffix, 1, max(0, needed - prefix_length)) || '"'))
 ), '{') END AS row_json
FROM journal_rows_data d;
CREATE TRIGGER journal_rows_compat_insert INSTEAD OF INSERT ON journal_rows
BEGIN
 INSERT INTO journal_rows_data(session_id, epoch, seq, ts, row_json, text_item_id)
 VALUES (NEW.session_id, NEW.epoch, NEW.seq, NEW.ts, NEW.row_json,
   CASE WHEN json_valid(NEW.row_json) THEN
    CASE WHEN json_extract(NEW.row_json, '$.kind') = 'item'
     THEN json_extract(NEW.row_json, '$.itemId') END END);
END;
CREATE TRIGGER journal_rows_compat_update INSTEAD OF UPDATE ON journal_rows
BEGIN
 UPDATE journal_rows_data SET session_id = NEW.session_id, epoch = NEW.epoch,
   seq = NEW.seq, ts = NEW.ts, row_json = NEW.row_json, text_generation = NULL,
   text_path = NULL,
   text_item_id = CASE WHEN json_valid(NEW.row_json) THEN
    CASE WHEN json_extract(NEW.row_json, '$.kind') = 'item'
     THEN json_extract(NEW.row_json, '$.itemId') END END
  WHERE session_id = OLD.session_id AND epoch = OLD.epoch AND seq = OLD.seq;
END;
CREATE TRIGGER journal_rows_compat_delete INSTEAD OF DELETE ON journal_rows
BEGIN
 DELETE FROM journal_rows_data
  WHERE session_id = OLD.session_id AND epoch = OLD.epoch AND seq = OLD.seq;
END;
CREATE TRIGGER journal_rows_piece_delete AFTER DELETE ON journal_rows_data
 WHEN OLD.text_generation IS NOT NULL
BEGIN
 DELETE FROM journal_text_pieces
  WHERE session_id = OLD.session_id AND epoch = OLD.epoch AND generation = OLD.text_generation
   AND NOT EXISTS (SELECT 1 FROM journal_rows_data d
    WHERE d.session_id = OLD.session_id AND d.epoch = OLD.epoch
     AND d.text_generation = OLD.text_generation);
END;
CREATE TRIGGER journal_rows_piece_update AFTER UPDATE OF text_generation ON journal_rows_data
 WHEN OLD.text_generation IS NOT NULL AND OLD.text_generation IS NOT NEW.text_generation
BEGIN
 DELETE FROM journal_text_pieces
  WHERE session_id = OLD.session_id AND epoch = OLD.epoch AND generation = OLD.text_generation
   AND NOT EXISTS (SELECT 1 FROM journal_rows_data d
    WHERE d.session_id = OLD.session_id AND d.epoch = OLD.epoch
     AND d.text_generation = OLD.text_generation);
END;
`)
  })
}
