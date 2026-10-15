import type Database from '../../sqlite/sync-database'
import { parseJournalRow, serializeJournalRow, type JournalRow } from './journal-row-schema'
import { AgentSessionJournalError } from './journal-write-guards'
import { readAgentJournalItemBody } from '../../../shared/agent-session-journal-body-admission'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { encodeJournalText, insertJournalTextPiece } from './journal-text-pieces'
import {
  JournalTextPieceReader,
  isJournalPhysicalRow,
  type JournalPhysicalRow
} from './journal-text-piece-reader'

export type JournalStoredRow = { epoch: string; seq: number; ts: number; rowJson: string }

const SELECT_EPOCH = 'SELECT epoch FROM journal_sessions WHERE session_id = ?'
const PUBLISH_SESSION_EPOCH = `INSERT INTO journal_sessions (session_id, workspace_id, epoch)
VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  workspace_id = excluded.workspace_id, epoch = excluded.epoch`
const INSERT_ROW = `INSERT INTO journal_rows_data
(session_id, epoch, seq, ts, row_json, text_generation, text_item_id, text_path)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
const SELECT_ROWS_AFTER = `SELECT seq, ts, row_json, text_generation, text_path FROM journal_rows_data
WHERE session_id = ? AND epoch = ? AND seq > ? ORDER BY seq ASC`
const DELETE_EPOCH = 'DELETE FROM journal_rows_data WHERE session_id = ? AND epoch = ?'
const SELECT_LAST_ACTIVITY = 'SELECT MAX(ts) AS ts FROM journal_rows_data WHERE session_id = ?'

export function readJournalSessionEpoch(db: Database.Database, sessionId: string): string | null {
  const epoch = db.prepare(SELECT_EPOCH).get(sessionId)?.epoch
  return typeof epoch === 'string' ? epoch : null
}

export function readJournalSessionLastActivityAt(db: Database.Database, sessionId: string): number | null {
  const ts = db.prepare(SELECT_LAST_ACTIVITY).get(sessionId)?.ts
  return typeof ts === 'number' ? ts : null
}

export function publishJournalSessionEpoch(
  db: Database.Database,
  identity: { sessionId: string; workspaceId: string },
  epoch: string
): void {
  db.prepare(PUBLISH_SESSION_EPOCH).run(identity.sessionId, identity.workspaceId, epoch)
}

export function insertJournalRow(
  db: Database.Database,
  sessionId: string,
  row: JournalRow,
  savedAt = row.ts,
  hint?: AgentJournalRenderItem
): number {
  const encoded = encodeJournalText(db, sessionId, row, hint)
  const readBack = parseJournalRow(encoded.rowJson)
  if (!readBack.ok || readBack.row.seq !== row.seq ||
      (row.kind === 'item' && readAgentJournalItemBody(row.body) !== 'readable')) {
    throw new AgentSessionJournalError(
      'journal_row_rejected',
      `the ${row.kind} row for ${sessionId} would not read back, so it was not written`
    )
  }
  db.prepare(INSERT_ROW).run(sessionId, row.epoch, row.seq, savedAt, encoded.rowJson,
    encoded.generation, row.kind === 'item' ? row.itemId : null, encoded.path)
  const textBytes = insertJournalTextPiece(db, sessionId, row, encoded)
  return Buffer.byteLength(encoded.rowJson, 'utf8') + textBytes
}

const EPOCH_ROW_PAGE_SIZE = 128

/** Each completed page releases its SQLite read snapshot before the reducer runs. */
export function* iterateJournalPhysicalRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): Generator<JournalPhysicalRow> {
  let afterSeq = Number.MIN_SAFE_INTEGER
  for (;;) {
    const page = readJournalPhysicalRowsAfter(db, sessionId, epoch, afterSeq, EPOCH_ROW_PAGE_SIZE)
    yield* page
    const last = page.at(-1)
    if (page.length < EPOCH_ROW_PAGE_SIZE || last === undefined) {
      return
    }
    afterSeq = last.seq
  }
}

export function* iterateJournalEpochRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): Generator<JournalStoredRow> {
  const reader = new JournalTextPieceReader(db)
  for (const row of iterateJournalPhysicalRows(db, sessionId, epoch)) {
    yield fullStoredRow(reader, sessionId, epoch, row)
  }
}

export function readJournalPhysicalRowsAfter(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSeq: number,
  limit?: number
): JournalPhysicalRow[] {
  const rows = limit === undefined
    ? db.prepare(SELECT_ROWS_AFTER).all(sessionId, epoch, afterSeq)
    : db.prepare(`${SELECT_ROWS_AFTER} LIMIT ?`).all(sessionId, epoch, afterSeq, limit)
  return rows.filter(isJournalPhysicalRow)
}

export function readJournalRowsAfter(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSeq: number,
  limit?: number
): JournalStoredRow[] {
  const reader = new JournalTextPieceReader(db)
  return readJournalPhysicalRowsAfter(db, sessionId, epoch, afterSeq, limit)
    .map((row) => fullStoredRow(reader, sessionId, epoch, row))
}

function fullStoredRow(
  reader: JournalTextPieceReader,
  sessionId: string,
  epoch: string,
  entry: JournalPhysicalRow
): JournalStoredRow {
  const parsed = reader.decode(sessionId, epoch, entry)
  const rowJson = parsed.ok
    ? entry.text_generation === null ? entry.row_json : serializeJournalRow(parsed.row)
    : entry.text_generation === null || parsed.unreadable ? entry.row_json : '{'
  return { epoch, seq: entry.seq, ts: entry.ts, rowJson }
}

export function deleteJournalEpochRows(db: Database.Database, sessionId: string, epoch: string): void {
  db.prepare(DELETE_EPOCH).run(sessionId, epoch)
}
