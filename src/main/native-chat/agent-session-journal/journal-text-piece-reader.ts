import type Database from '../../sqlite/sync-database'
import { parseJournalRow, type JournalRowParse } from './journal-row-schema'
import { escapeJournalText, replaceJournalStreamedText } from './journal-streamed-text-field'
import { readAgentJournalItemBody } from '../../../shared/agent-session-journal-body-admission'

export type JournalPhysicalRow = {
  seq: number
  ts: number
  row_json: string
  text_generation: string | null
  text_path: string | null
}

export type JournalTextPiece = {
  seq: number
  parent: number | null
  prefix: number
  units: number
  length: number
  unitLength: number
  suffix: string
}
type TextBoundary = { units: number; escaped: number }
type TextAncestor = Omit<JournalTextPiece, 'suffix'>
type DecodedText = {
  piece: JournalTextPiece
  text: string
  boundaries: TextBoundary[]
  lineage: TextAncestor[]
}
const MAX_CACHED_TEXT_BYTES = 32 * 1024 * 1024
const MAX_CACHED_GENERATIONS = 256

function sameJournalTextPiece(left: JournalTextPiece, right: JournalTextPiece): boolean {
  return left.seq === right.seq && left.parent === right.parent && left.prefix === right.prefix &&
    left.units === right.units && left.length === right.length &&
    left.unitLength === right.unitLength && left.suffix === right.suffix
}

function reusableParent(cached: DecodedText, piece: JournalTextPiece): TextAncestor[] | null {
  const index = cached.lineage.findIndex((ancestor) => ancestor.seq === piece.parent)
  if (index === -1 || cached.lineage.slice(index + 1).some((edge) => edge.units < piece.units)) {
    return null
  }
  return cached.lineage.slice(0, index + 1)
}

export function readJournalTextPiece(record: Record<string, unknown>): JournalTextPiece | null {
  const { seq, parent_seq: parent, prefix_length: prefix, prefix_units: units,
    text_length: length, text_units: unitLength, suffix } = record
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 ||
      (parent !== null && (typeof parent !== 'number' || !Number.isSafeInteger(parent) || parent < 1 || parent >= seq)) ||
      typeof prefix !== 'number' || !Number.isSafeInteger(prefix) || prefix < 0 ||
      typeof units !== 'number' || !Number.isSafeInteger(units) || units < 0 ||
      typeof length !== 'number' || !Number.isSafeInteger(length) || length < prefix ||
      typeof unitLength !== 'number' || !Number.isSafeInteger(unitLength) || unitLength < units ||
      typeof suffix !== 'string' || !/^[\x20-\x7e]*$/.test(suffix) ||
      length !== prefix + suffix.length || (parent === null && (prefix !== 0 || units !== 0))) {
    return null
  }
  return { seq, parent, prefix, units, length, unitLength, suffix }
}

/** Owned by one synchronous read/replay or write transaction; never survives that operation. */
export class JournalTextPieceReader {
  private readonly cache = new Map<string, DecodedText>()
  private bytes = 0

  constructor(private readonly db: Database.Database) {}

  read(sessionId: string, epoch: string, generation: string, sequence: number): string | null {
    const cached = this.cache.get(generation)
    if (cached) {
      this.cache.delete(generation)
      this.bytes -= this.retainedBytes(cached)
    }
    const record = this.db.prepare(`SELECT seq, parent_seq, prefix_length, prefix_units,
text_length, text_units, suffix FROM journal_text_pieces
WHERE session_id = ? AND epoch = ? AND generation = ? AND seq = ?`)
      .get(sessionId, epoch, generation, sequence)
    const target = record ? readJournalTextPiece(record) : null
    if (!target) {
      return null
    }
    if (cached?.piece.seq === sequence) {
      // This operation already validated the ancestry; recheck its exact anchor before reuse.
      if (sameJournalTextPiece(target, cached.piece)) {
        this.remember(generation, cached)
        return cached.text
      }
    }
    const lineage = cached ? reusableParent(cached, target) : null
    let decoded: DecodedText | null = cached && lineage ? { ...cached, lineage } : null
    // SQLite owns the transient reverse walk; retain only the active path's compact metadata.
    const records = decoded && record ? [record] : this.db.prepare(`WITH RECURSIVE path AS (
 SELECT seq, parent_seq, prefix_length, prefix_units, text_length, text_units, suffix
 FROM journal_text_pieces WHERE session_id = ? AND epoch = ? AND generation = ? AND seq = ?
 UNION ALL
 SELECT p.seq, p.parent_seq, p.prefix_length, p.prefix_units, p.text_length, p.text_units, p.suffix
 FROM path child JOIN journal_text_pieces p ON p.session_id = ? AND p.epoch = ?
 AND p.generation = ? AND p.seq = child.parent_seq AND p.seq < child.seq
) SELECT seq, parent_seq, prefix_length, prefix_units, text_length, text_units, suffix
FROM path ORDER BY seq`).iterate(sessionId, epoch, generation, sequence, sessionId, epoch, generation)
    for (const entry of records) {
      const piece = readJournalTextPiece(entry)
      const parent = decoded?.lineage.at(-1)
      if (!piece || piece.parent !== (parent?.seq ?? null) ||
          piece.prefix > (parent?.length ?? 0) || piece.units > (parent?.unitLength ?? 0)) {
        return null
      }
      let suffix: unknown
      try {
        suffix = JSON.parse(`"${piece.suffix}"`)
      } catch {
        return null
      }
      if (typeof suffix !== 'string' || piece.unitLength !== piece.units + suffix.length ||
          escapeJournalText(suffix) !== piece.suffix) {
        return null
      }
      const boundaries = decoded?.boundaries ?? [{ units: 0, escaped: 0 }]
      while (boundaries.length > 1 && (boundaries.at(-1)?.units ?? 0) > piece.units) {
        boundaries.pop()
      }
      const boundary = boundaries.at(-1) ?? { units: 0, escaped: 0 }
      const escapedPrefix = boundary.escaped +
        escapeJournalText((decoded?.text ?? '').slice(boundary.units, piece.units)).length
      if (escapedPrefix !== piece.prefix) {
        return null
      }
      let escapedAt = piece.prefix
      // Fixed boundaries keep tiny checkpoints from retaining one boundary per historical row.
      let start = 0
      while (start < suffix.length) {
        const end = Math.min(start + 256 - ((piece.units + start) % 256), suffix.length)
        escapedAt += escapeJournalText(suffix.slice(start, end)).length
        if ((piece.units + end) % 256 === 0) {
          boundaries.push({ units: piece.units + end, escaped: escapedAt })
        }
        start = end
      }
      const { suffix: _suffix, ...ancestor } = piece
      const ancestry = decoded?.lineage ?? []
      ancestry.push(ancestor)
      decoded = {
        piece, text: (decoded?.text ?? '').slice(0, piece.units) + suffix, boundaries, lineage: ancestry
      }
    }
    if (decoded?.piece.seq === sequence) {
      this.remember(generation, decoded)
      return decoded.text
    }
    return null
  }

  decode(sessionId: string, epoch: string, entry: JournalPhysicalRow): JournalRowParse {
    const parsed = parseJournalRow(entry.row_json)
    if (!parsed.ok || entry.text_generation === null) {
      return parsed
    }
    const text = this.read(sessionId, epoch, entry.text_generation, entry.seq)
    const row = text === null || entry.text_path === null ? null :
      replaceJournalStreamedText(parsed.row, entry.text_path, text)
    return row?.kind === 'item' && readAgentJournalItemBody(row.body) === 'readable'
      ? { ok: true, row }
      : { ok: false, unreadable: false }
  }

  private remember(generation: string, decoded: DecodedText): void {
    const previous = this.cache.get(generation)
    this.bytes -= previous ? this.retainedBytes(previous) : 0
    this.cache.delete(generation)
    this.cache.set(generation, decoded)
    this.bytes += this.retainedBytes(decoded)
    while (this.cache.size > MAX_CACHED_GENERATIONS || this.bytes > MAX_CACHED_TEXT_BYTES) {
      const oldest = this.cache.entries().next().value
      if (!oldest) {
        break
      }
      this.bytes -= this.retainedBytes(oldest[1])
      this.cache.delete(oldest[0])
    }
  }

  private retainedBytes(decoded: DecodedText): number {
    return decoded.text.length * 2 + decoded.piece.suffix.length +
      decoded.boundaries.length * 16 + decoded.lineage.length * 56
  }
}

export function isJournalPhysicalRow(record: Record<string, unknown>): record is JournalPhysicalRow {
  return typeof record.seq === 'number' && typeof record.ts === 'number' &&
    typeof record.row_json === 'string' &&
    (record.text_generation === null || typeof record.text_generation === 'string') &&
    (record.text_path === null || typeof record.text_path === 'string')
}
