import type Database from '../../sqlite/sync-database'
import { escapeJournalText } from './journal-streamed-text-field'

type SuffixBoundary = Readonly<{ units: number; escaped: number }>
type PreparedSuffix = Readonly<{
  text: string
  boundaries: readonly SuffixBoundary[]
}>
type SuffixEntry = {
  suffix: string
  alignment: number
  bytes: number
  prepared: PreparedSuffix
}

const MAX_SUFFIX_BYTES = 32 * 1024 * 1024
const MAX_SUFFIX_ENTRIES = 4096
const preparations = new WeakMap<Database.Database, JournalSuffixPreparations>()

function prepareSuffix(suffix: string, alignment: number): PreparedSuffix | null {
  let text: unknown
  try {
    text = JSON.parse(`"${suffix}"`)
  } catch {
    return null
  }
  if (typeof text !== 'string' || escapeJournalText(text) !== suffix) {
    return null
  }
  const boundaries: SuffixBoundary[] = []
  let escaped = 0
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + 256 - ((alignment + start) % 256), text.length)
    escaped += escapeJournalText(text.slice(start, end)).length
    if ((alignment + end) % 256 === 0) {
      boundaries.push(Object.freeze({ units: end, escaped }))
    }
    start = end
  }
  return Object.freeze({ text, boundaries: Object.freeze(boundaries) })
}

/** Shares only an exact literal's pure transform; saved-path validity stays with each reader. */
class JournalSuffixPreparations {
  private readonly bySuffix = new Map<string, Map<number, SuffixEntry>>()
  private readonly recent = new Map<SuffixEntry, true>()
  private bytes = 0

  prepare(suffix: string, alignment: number): PreparedSuffix | null {
    const cached = this.bySuffix.get(suffix)?.get(alignment)
    if (cached) {
      this.recent.delete(cached)
      this.recent.set(cached, true)
      return cached.prepared
    }
    const prepared = prepareSuffix(suffix, alignment)
    if (!prepared) {
      return null
    }
    // Charge both strings for every alignment, offsets, and reserved map/entry overhead.
    const bytes = 2 * (suffix.length + prepared.text.length) +
      16 * prepared.boundaries.length + 256
    if (bytes > MAX_SUFFIX_BYTES) {
      return prepared
    }
    const entry = { suffix, alignment, bytes, prepared }
    const alignments = this.bySuffix.get(suffix) ?? new Map<number, SuffixEntry>()
    alignments.set(alignment, entry)
    this.bySuffix.set(suffix, alignments)
    this.recent.set(entry, true)
    this.bytes += bytes
    while (this.bytes > MAX_SUFFIX_BYTES || this.recent.size > MAX_SUFFIX_ENTRIES) {
      const oldest = this.recent.keys().next().value
      if (!oldest) {
        break
      }
      this.recent.delete(oldest)
      this.bytes -= oldest.bytes
      const remaining = this.bySuffix.get(oldest.suffix)
      remaining?.delete(oldest.alignment)
      if (remaining?.size === 0) {
        this.bySuffix.delete(oldest.suffix)
      }
    }
    return prepared
  }
}

export function prepareJournalTextSuffix(
  db: Database.Database,
  suffix: string,
  alignment: number
): PreparedSuffix | null {
  let memo = preparations.get(db)
  if (!memo) {
    memo = new JournalSuffixPreparations()
    preparations.set(db, memo)
  }
  return memo.prepare(suffix, alignment)
}

export function clearJournalTextSuffixPreparations(db: Database.Database): void {
  preparations.delete(db)
}
