// The one bound every saved item body keeps: no text in it past `JOURNAL_PAYLOAD_MAX_BYTES`.
//
// A single write past the journal write queue's caps stalls the chat, so a larger text keeps its
// head and tail. It is applied where every provider's rows enter that queue
// (structured-agent-session-event-sink.ts), so no translator has to remember it.

import type { AgentJournalBoundedPayload } from '../../../shared/agent-session-journal-types'
import { JOURNAL_PAYLOAD_MAX_BYTES, journalTextWithinCeiling } from './journal-payload-bounds'

function isBoundedPayload(value: object): value is AgentJournalBoundedPayload {
  return (
    'head' in value &&
    typeof value.head === 'string' &&
    'byteLength' in value &&
    'truncated' in value
  )
}

function longestString(value: unknown): number {
  if (typeof value === 'string') {
    return value.length
  }
  if (typeof value !== 'object' || value === null) {
    return 0
  }
  let longest = 0
  for (const entry of Object.values(value)) {
    longest = Math.max(longest, longestString(entry))
  }
  return longest
}

function ceil(value: unknown): unknown {
  if (typeof value === 'string') {
    return journalTextWithinCeiling(value)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (!Array.isArray(value) && isBoundedPayload(value)) {
    const head = journalTextWithinCeiling(value.head)
    return head === value.head ? value : { ...value, head, truncated: true }
  }
  const entries = Object.entries(value)
  const kept = entries.map(([, entry]) => ceil(entry))
  if (kept.every((entry, index) => entry === entries[index]![1])) {
    return value
  }
  return Array.isArray(value)
    ? kept
    : Object.fromEntries(entries.map(([key], index) => [key, kept[index]]))
}

/** `body` itself when no text in it is past the ceiling; otherwise a copy with each such text cut
 *  to its head and tail. */
export function journalBodyWithinCeiling<T>(body: T): T {
  // A string's UTF-16 length bounds its UTF-8 bytes from below by a third.
  if (longestString(body) * 3 <= JOURNAL_PAYLOAD_MAX_BYTES) {
    return body
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `ceil` keeps every key and shape and only shortens strings.
  return ceil(body) as T
}
