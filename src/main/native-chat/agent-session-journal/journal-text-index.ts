import type Database from '../../sqlite/sync-database'
import { iterateJournalEpochRows } from './journal-row-table'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import {
  journalTextField,
  journalTextFields,
  journalWholeItem,
  type JournalSequenceRange,
  type JournalTextPrunedRow
} from './journal-text-rows'

export type JournalTextPieces = {
  itemId: string
  field: number
  marker: number
  witness: number
  revision: number
  ranges: JournalSequenceRange[]
}

export function journalTextKey(itemId: string, field: number): string {
  return JSON.stringify([itemId, field])
}

/** Derived positions only: neither reply strings nor a durable cleanup obligation. */
export class JournalTextIndex {
  readonly pieces = new Map<string, JournalTextPieces>()
  readonly ready = new Set<string>()
  private readonly protectedOnly = new Set<string>()
  private readonly covered: JournalSequenceRange[] = []
  private readonly superseded = new Map<string, number>()

  covers = (first: number, last: number): boolean => {
    if (last < first) {
      return true
    }
    let low = 0
    let high = this.covered.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.covered[mid][1] < first) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return (
      low < this.covered.length && this.covered[low][0] <= first && this.covered[low][1] >= last
    )
  }

  supersedes(itemId: string, field: number, revision: number): boolean {
    return revision <= (this.superseded.get(journalTextKey(itemId, field)) ?? 0)
  }

  overlaps(first: number, last: number): boolean {
    return this.covered.some(([start, end]) => first <= end && last >= start)
  }

  certify(row: JournalTextPrunedRow): void {
    const key = journalTextKey(row.itemId, row.field)
    this.superseded.set(key, Math.max(this.superseded.get(key) ?? 0, row.revision))
    this.covered.push(...row.ranges)
    this.covered.sort((a, b) => a[0] - b[0])
    for (let i = this.covered.length - 1; i > 0; i--) {
      const previous = this.covered[i - 1]
      const current = this.covered[i]
      if (previous[1] + 1 >= current[0]) {
        this.covered.splice(i - 1, 2, [previous[0], Math.max(previous[1], current[1])])
      }
    }
  }

  observe(row: JournalRow): void {
    if (row.kind === 'text-pruned') {
      this.certify(row)
      const piece = this.pieces.get(journalTextKey(row.itemId, row.field))
      if (piece) {
        piece.ranges = subtractJournalTextRanges(piece.ranges, row.ranges)
      }
    } else if (row.kind === 'text-delta') {
      const piece = this.pieces.get(journalTextKey(row.itemId, row.field))
      if (!piece?.marker) {
        throw new Error('journal_text_anchor_missing')
      }
      const last = piece.ranges.at(-1)
      if (last && last[1] + 1 === row.seq) {
        piece.ranges[piece.ranges.length - 1] = [last[0], row.seq]
      } else {
        piece.ranges.push([row.seq, row.seq])
      }
    } else if (row.kind === 'item' || row.kind === 'lifecycle-batch') {
      const items = row.kind === 'item' ? [row] : row.mutations
      for (const item of items) {
        if (item.kind !== 'item') {
          continue
        }
        for (const field of journalTextFields(item.body)) {
          const key = journalTextKey(item.itemId, field)
          const piece = this.pieces.get(key) ?? {
            itemId: item.itemId,
            field,
            marker: 0,
            witness: 0,
            revision: 0,
            ranges: []
          }
          if (row.v >= 5 && !piece.marker) {
            piece.marker = row.seq
          }
          if (item.revision > piece.revision) {
            piece.witness = row.seq
            piece.revision = item.revision
          }
          this.pieces.set(key, piece)
        }
      }
    }
  }

  reconsider(key: string, protectedRows: ReadonlySet<number>): void {
    const piece = this.pieces.get(key)
    if (!piece) {
      return
    }
    const eligible = piece.ranges.some(
      ([first, last]) =>
        first < piece.witness &&
        (Math.min(last, piece.witness - 1) - first + 1 > protectedRows.size ||
          Array.from(
            { length: Math.min(last, piece.witness - 1) - first + 1 },
            (_, n) => first + n
          ).some((seq) => !protectedRows.has(seq)))
    )
    if (eligible) {
      this.ready.add(key)
      this.protectedOnly.delete(key)
    } else {
      this.ready.delete(key)
      if (piece.ranges.some(([first]) => first < piece.witness)) {
        this.protectedOnly.add(key)
      } else {
        this.protectedOnly.delete(key)
      }
    }
  }

  reconsiderProtected(protectedRows: ReadonlySet<number>): void {
    for (const key of this.protectedOnly) {
      this.reconsider(key, protectedRows)
    }
  }

  changed(row: JournalRow, protectedRows: ReadonlySet<number>): void {
    this.observe(row)
    if (row.kind === 'item') {
      for (const field of journalTextFields(row.body)) {
        this.reconsider(journalTextKey(row.itemId, field), protectedRows)
      }
    } else if (row.kind === 'lifecycle-batch') {
      for (const item of row.mutations) {
        if (item.kind === 'item') {
          for (const field of journalTextFields(item.body)) {
            this.reconsider(journalTextKey(item.itemId, field), protectedRows)
          }
        }
      }
    } else if (row.kind === 'text-pruned' || row.kind === 'text-delta') {
      this.reconsider(journalTextKey(row.itemId, row.field), protectedRows)
    }
  }
}

export function subtractJournalTextRanges(
  ranges: readonly JournalSequenceRange[],
  removed: readonly JournalSequenceRange[]
): JournalSequenceRange[] {
  return ranges.flatMap(([first, last]) => {
    const kept: JournalSequenceRange[] = []
    let start = first
    for (const [cutFirst, cutLast] of removed) {
      if (cutLast < start || cutFirst > last) {
        continue
      }
      if (cutFirst > start) {
        kept.push([start, cutFirst - 1])
      }
      start = Math.max(start, cutLast + 1)
    }
    if (start <= last) {
      kept.push([start, last])
    }
    return kept
  })
}

export function readJournalTextRow(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  seq: number
): JournalRow | null {
  const stored = db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?')
    .get(sessionId, epoch, seq)
  const parsed =
    typeof stored?.row_json === 'string' ? parseJournalRow(stored.row_json, true) : null
  return parsed?.ok && parsed.row.seq === seq && parsed.row.epoch === epoch ? parsed.row : null
}

export function validateJournalTextProof(
  db: Database.Database,
  sessionId: string,
  row: JournalTextPrunedRow,
  deleted = true
): boolean {
  const marker = readJournalTextRow(db, sessionId, row.epoch, row.marker)
  const witness = readJournalTextRow(db, sessionId, row.epoch, row.witness)
  if (
    !marker ||
    marker.v < 5 ||
    marker.kind !== 'item' ||
    !witness ||
    (witness.kind !== 'item' && witness.kind !== 'lifecycle-batch')
  ) {
    return false
  }
  const whole = journalWholeItem(witness, row.itemId, row.revision)
  if (
    marker.itemId !== row.itemId ||
    journalTextField(marker.body, row.field) === null ||
    !whole ||
    journalTextField(whole.body, row.field) === null ||
    marker.revision >= whole.revision
  ) {
    return false
  }
  let previous = row.marker
  for (const [first, last] of row.ranges) {
    if (first <= previous || last < first || last >= row.witness) {
      return false
    }
    if (
      deleted &&
      db
        .prepare(
          'SELECT seq FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq BETWEEN ? AND ? LIMIT 1'
        )
        .get(sessionId, row.epoch, first, last)
    ) {
      return false
    }
    previous = last
  }
  return true
}

/** First paged pass retains certificates only; whole witnesses are fetched by their keys. */
export function loadJournalTextIndex(db: Database.Database, sessionId: string, epoch: string) {
  const index = new JournalTextIndex()
  let invalidAt: number | null = null
  let newer: number | null = null
  for (const entry of iterateJournalEpochRows(db, sessionId, epoch)) {
    const parsed = parseJournalRow(entry.rowJson, true)
    if (!parsed.ok) {
      if (parsed.unreadable) {
        newer ??= entry.seq
      }
      continue
    }
    const row = parsed.row
    if (row.kind !== 'text-pruned') {
      continue
    }
    if (
      row.seq !== entry.seq ||
      row.epoch !== epoch ||
      !validateJournalTextProof(db, sessionId, row) ||
      row.ranges.some(([first, last]) => index.overlaps(first, last))
    ) {
      invalidAt ??= entry.seq
    } else {
      index.certify(row)
    }
  }
  return { index, invalidAt, newer }
}
