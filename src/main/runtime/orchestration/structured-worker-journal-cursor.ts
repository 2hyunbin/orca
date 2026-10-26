/** Page a live structured journal: newest messages first, then forward from the last message delivered.
 * Messages are revised in place while they stream, so a cursor names that message and its revision rather
 * than a position: a revised last message is sent again, and only losing it from the journal invalidates it. */

import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../shared/structured-agent-session-projection'
import { OrchestrationError } from './orchestration-error'
import type { StructuredLineageJournalPage } from './structured-worker-journal-page'
import { createWorkerOutputSourceIdentity } from './worker-output-cursor'
import { boundWorkerTranscriptMessages } from './worker-transcript-payload'

export type StructuredJournalEntry = {
  anchor: string
  revision: number
  message: NativeChatMessage
}

/** The last message a reader holds; a null anchor predates every message. */
export type StructuredJournalAnchor = { anchor: string | null; revision: number }

/** Projected messages keyed by item identity, which revisions keep. */
export function structuredJournalEntries(
  rootSessionId: string,
  page: StructuredLineageJournalPage
): StructuredJournalEntry[] {
  return page.items.flatMap((item, index) => {
    const message = projectStructuredItemToNativeChat(item)
    if (!message) {
      return []
    }
    // Namespace successor items by session because /clear copies drafts.
    const sessionId = page.sessionIds[index]
    const key =
      sessionId === undefined || sessionId === rootSessionId
        ? item.itemId
        : `${sessionId}/${item.itemId}`
    return [{ anchor: createWorkerOutputSourceIdentity([key]), revision: item.revision, message }]
  })
}

export function pageStructuredJournal(input: {
  entries: readonly StructuredJournalEntry[]
  from: StructuredJournalAnchor | null
  limit: number
  hasOlder: boolean
}): {
  messages: NativeChatMessage[]
  next: StructuredJournalAnchor
  clipping: string[]
  warnings: string[]
} {
  const { entries, from, limit } = input
  const start = from ? resumeIndex(entries, from) : Math.max(0, entries.length - limit)
  const candidates = entries.slice(start, start + limit)
  const texts = candidates.map((entry) => entry.message)
  // A first read bounds newest-first so the size limit drops the oldest candidates, never the latest progress.
  const bounded = boundWorkerTranscriptMessages(from ? texts : texts.toReversed())
  const first = start + (from ? 0 : candidates.length - bounded.messages.length)
  const served = entries.slice(first, first + bounded.messages.length)
  // Only a reader holding no message can have missed older ones.
  const olderOmitted = !from?.anchor && (first > 0 || input.hasOlder)
  const more = first + served.length < entries.length
  const last = served.at(-1)
  return {
    messages: from ? bounded.messages : bounded.messages.toReversed(),
    next: last
      ? { anchor: last.anchor, revision: last.revision }
      : (from ?? { anchor: null, revision: 0 }),
    clipping: [
      ...(olderOmitted || more ? ['message_limit_or_scan_window'] : []),
      ...(bounded.limited ? ['transcript_payload'] : [])
    ],
    warnings: [
      ...bounded.warnings,
      ...(olderOmitted
        ? ['Older journal items were omitted from this page; the cursor follows only newer ones.']
        : [])
    ]
  }
}

/** First entry the reader has not seen at its current revision. */
function resumeIndex(
  entries: readonly StructuredJournalEntry[],
  from: StructuredJournalAnchor
): number {
  if (!from.anchor) {
    return 0
  }
  const at = entries.findIndex((entry) => entry.anchor === from.anchor)
  if (at === -1) {
    throw new OrchestrationError(
      'source_changed',
      'The worker transcript no longer holds the message this cursor follows. Read again without --cursor for the newest messages.'
    )
  }
  // Re-send a revised anchor, as a streaming reply or a tool call gaining its result is.
  return entries[at]?.revision === from.revision ? at + 1 : at
}
