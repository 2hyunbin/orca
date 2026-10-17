// Journal payloads: what a row keeps of a tool output or diff.
//
// A row keeps the whole value; only what is sent to a client is bounded (the item wire form in
// agent-session-wire), so no writer can turn a transport limit into lost content. Two bounds stay:
// any text past `JOURNAL_PAYLOAD_MAX_BYTES` keeps its head and tail (journal-body-ceiling.ts), and
// a Grok, OpenCode, OMP or Pi call still running keeps a preview that its closing revision
// replaces. The byte clip below also serves keys and the few fields with their own named limit.

import { createHash } from 'node:crypto'
import type { AgentJournalBoundedPayload } from '../../../shared/agent-session-journal-types'

export type JournalPayloadLimits = {
  /** Bytes of the payload kept in `head`. */
  inlineHeadBytes: number
}

/** Past this one write outgrows the journal write queue (16 MiB per lifecycle write), which stalls
 *  the chat, so a larger text keeps its head and tail, where a log's command and errors are. */
export const JOURNAL_PAYLOAD_MAX_BYTES = 4 * 1024 * 1024

/** What a revision of a call still running keeps where every update is a row and the open budget
 *  holds it (provider-timeline-budget.ts); its closing revision keeps the whole value. */
export const JOURNAL_RUNNING_PREVIEW_LIMITS: JournalPayloadLimits = {
  inlineHeadBytes: 16 * 1024
}

/** The raw provider frame a row keeps behind its disclosure: a record of traffic Orca cannot
 *  model, not content the agent said, so it keeps a head. */
export const PROVIDER_FRAME_PAYLOAD_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }

/** A send's rejection reason: a provider error body of any size, not conversation content, and
 *  it rides the submission list rather than an item (#20654). */
export const JOURNAL_DISPATCH_REASON_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }

/** Marker appended to a clipped inline string so the UI never presents a
 *  truncated body as complete. Kept in the text itself because block-level
 *  payloads (tool-result output) have nowhere else to carry the flag. */
export function journalTruncationMarker(byteLength: number, digest: string): string {
  return `\n[Orca: output truncated — ${byteLength} bytes total, digest ${digest.slice(0, 12)}]`
}

export function digestPayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** The whole value, as a tool output or diff is saved. */
export function journalPayload(payload: string): AgentJournalBoundedPayload {
  return {
    head: payload,
    byteLength: Buffer.byteLength(payload, 'utf8'),
    digest: digestPayload(payload),
    truncated: false
  }
}

/** `text` itself within `JOURNAL_PAYLOAD_MAX_BYTES`; past it, its head and tail. */
export function journalTextWithinCeiling(text: string): string {
  // UTF-8 spends at most three bytes per UTF-16 unit, so most text needs no encoding.
  if (text.length * 3 <= JOURNAL_PAYLOAD_MAX_BYTES) {
    return text
  }
  const byteLength = Buffer.byteLength(text, 'utf8')
  if (byteLength <= JOURNAL_PAYLOAD_MAX_BYTES) {
    return text
  }
  const keep = JOURNAL_PAYLOAD_MAX_BYTES / 2
  const head = utf8Head(text, keep)
  const tail = utf8Tail(text, keep)
  const omitted = byteLength - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8')
  return `${head}\n… [Orca kept the start and end; ${omitted} bytes in between were not saved] …\n${tail}`
}

/** Whole once `running` is false; a preview while the call still runs. */
export function journalToolPayload(payload: string, running: boolean): AgentJournalBoundedPayload {
  return running ? boundPayload(payload, JOURNAL_RUNNING_PREVIEW_LIMITS) : journalPayload(payload)
}

/** Clip `payload` to the inline head. `truncated` means the head is not the whole value;
 *  `digest` and `byteLength` describe the original. */
export function boundPayload(
  payload: string,
  limits: JournalPayloadLimits
): AgentJournalBoundedPayload {
  const byteLength = Buffer.byteLength(payload, 'utf8')
  const digest = digestPayload(payload)
  if (byteLength <= limits.inlineHeadBytes) {
    return { head: payload, byteLength, digest, truncated: false }
  }
  return { head: utf8Head(payload, limits.inlineHeadBytes), byteLength, digest, truncated: true }
}

/** The first `maxBytes` of `text` as UTF-8, never splitting a character; encodes only that head. */
export function utf8Head(text: string, maxBytes: number): string {
  const boundedBuffer =
    Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? Buffer.allocUnsafe(maxBytes) : null
  return boundedBuffer
    ? boundedBuffer.toString('utf8', 0, boundedBuffer.write(text, 0, boundedBuffer.length, 'utf8'))
    : clipUtf8(Buffer.from(text, 'utf8'), maxBytes)
}

/** Bound a plain string that must stay a string, keeping the explicit marker inline. */
export function boundInlineText(
  payload: string,
  limits: JournalPayloadLimits
): { text: string; bounded: AgentJournalBoundedPayload } {
  const bounded = boundPayload(payload, limits)
  if (!bounded.truncated) {
    return { text: payload, bounded }
  }
  return {
    text: bounded.head + journalTruncationMarker(bounded.byteLength, bounded.digest),
    bounded
  }
}

/** Tool input JSON over the limit, as its head and the original's size and digest. */
export function boundToolInput(input: unknown, limits: JournalPayloadLimits): unknown {
  let encoded: string
  try {
    encoded = JSON.stringify(input) ?? 'null'
  } catch {
    return {
      truncated: true,
      byteLength: 0,
      digest: digestPayload(''),
      head: '[unserializable input]'
    }
  }
  const bounded = boundPayload(encoded, limits)
  return bounded.truncated
    ? {
        truncated: true,
        byteLength: bounded.byteLength,
        digest: bounded.digest,
        head: bounded.head
      }
    : input
}

/** The last `maxBytes` of `text` as UTF-8, never splitting a character. */
function utf8Tail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  let start = Math.max(0, buffer.length - maxBytes)
  while (start < buffer.length && (buffer[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1
  }
  return buffer.subarray(start).toString('utf8')
}

/** Slice at a byte budget without splitting a multi-byte character. */
function clipUtf8(buffer: Buffer, maxBytes: number): string {
  let end = maxBytes
  // A UTF-8 continuation byte is 0b10xxxxxx; walk back off a split sequence.
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1
  }
  return buffer.subarray(0, end).toString('utf8')
}
