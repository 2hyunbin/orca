import { createHash, randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { serializeJournalRow, type JournalRow } from './journal-row-schema'
import {
  escapeJournalText,
  journalStreamedText,
  journalTextCommonPrefix,
  replaceJournalStreamedText,
  type JournalTextPath
} from './journal-streamed-text-field'
import {
  JournalTextPieceReader,
  readJournalTextPiece,
  type JournalTextPiece
} from './journal-text-piece-reader'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'

const transactionReaders = new WeakMap<Database.Database, JournalTextPieceReader>()

/** Synchronous transaction ownership prevents any decoded hint surviving a rollback. */
export function withJournalTextTransaction<T>(db: Database.Database, run: () => T): T {
  const previous = transactionReaders.get(db)
  transactionReaders.set(db, new JournalTextPieceReader(db))
  try {
    return run()
  } finally {
    if (previous) {
      transactionReaders.set(db, previous)
    } else {
      transactionReaders.delete(db)
    }
  }
}

type EncodedJournalText =
  | { rowJson: string; generation: null; path: null }
  | {
      rowJson: string
      generation: string
      path: JournalTextPath
      piece: JournalTextPiece
      digest: string
    }

export function encodeJournalText(
  db: Database.Database,
  sessionId: string,
  row: JournalRow,
  hint?: AgentJournalRenderItem
): EncodedJournalText {
  const value = journalStreamedText(row)
  const skeleton = value ? replaceJournalStreamedText(row, value.path, '') : null
  if (!value || !skeleton || row.kind !== 'item') {
    return { rowJson: serializeJournalRow(row), generation: null, path: null }
  }
  const reader = transactionReaders.get(db) ?? new JournalTextPieceReader(db)
  const previous = db.prepare(`SELECT seq, text_generation, text_path FROM journal_rows_data
WHERE session_id = ? AND epoch = ? AND text_item_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1`)
    .get(sessionId, row.epoch, row.itemId, row.seq)
  let generation = randomUUID()
  let parent: number | null = null
  let units = 0
  if (typeof previous?.seq === 'number' && typeof previous.text_generation === 'string' &&
      previous.text_path === value.path) {
    const tip = db.prepare(`SELECT MAX(seq) AS seq FROM journal_text_pieces
WHERE session_id = ? AND epoch = ? AND generation = ?`)
      .get(sessionId, row.epoch, previous.text_generation)?.seq
    // A legacy repair may retain referenced pieces past its new tip: never attach to that tail.
    if (tip === previous.seq) {
      const anchor = db.prepare(`SELECT text_digest FROM journal_text_pieces
WHERE session_id = ? AND epoch = ? AND generation = ? AND seq = ?`)
        .get(sessionId, row.epoch, previous.text_generation, previous.seq)
      const hinted = hint?.itemId === row.itemId
        ? journalStreamedText({ ...row, body: hint.body }) : null
      const prior = hinted?.path === value.path && textDigest(hinted.text) === anchor?.text_digest
        ? hinted.text
        : reader.read(sessionId, row.epoch, previous.text_generation, previous.seq)
      if (prior !== null) {
        units = journalTextCommonPrefix(prior, value.text)
        if (units > 0 && (units >= 32 || units === value.text.length)) {
          const prefix = escapeJournalText(value.text.slice(0, units)).length
          let candidate: number | null = previous.seq
          let requiredUnits = units
          let requiredPrefix = prefix
          while (candidate !== null) {
            const record = db.prepare(`SELECT seq, parent_seq, prefix_length, prefix_units,
text_length, text_units, suffix FROM journal_text_pieces
WHERE session_id = ? AND epoch = ? AND generation = ? AND seq = ?`)
              .get(sessionId, row.epoch, previous.text_generation, candidate)
            const piece = record ? readJournalTextPiece(record) : null
            if (!piece || piece.unitLength < requiredUnits || piece.length < requiredPrefix ||
                (piece.units >= units && piece.prefix < prefix)) {
              break
            }
            if (piece.units < units) {
              generation = previous.text_generation
              parent = piece.seq
              break
            }
            requiredUnits = piece.units
            requiredPrefix = piece.prefix
            candidate = piece.parent
          }
        }
        if (parent === null) {
          units = 0
        }
      }
    }
  }
  const prefix = escapeJournalText(value.text.slice(0, units)).length
  const suffix = escapeJournalText(value.text.slice(units))
  return {
    rowJson: serializeJournalRow(skeleton), generation, path: value.path,
    digest: textDigest(value.text),
    piece: { seq: row.seq, parent, prefix, units, length: prefix + suffix.length,
      unitLength: value.text.length, suffix }
  }
}

export function insertJournalTextPiece(
  db: Database.Database,
  sessionId: string,
  row: JournalRow,
  encoded: EncodedJournalText
): number {
  if (encoded.generation === null) {
    return 0
  }
  const piece = encoded.piece
  db.prepare(`INSERT INTO journal_text_pieces
(session_id, epoch, generation, seq, parent_seq, prefix_length, prefix_units, text_length, text_units, text_digest, suffix)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, row.epoch, encoded.generation,
      piece.seq, piece.parent, piece.prefix, piece.units, piece.length, piece.unitLength,
      encoded.digest, piece.suffix)
  return piece.suffix.length
}

function textDigest(text: string): string {
  return createHash('sha256').update(text, 'utf16le').digest('hex')
}
