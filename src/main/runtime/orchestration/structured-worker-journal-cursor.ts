/** Read a live structured journal for worker-read: the newest messages first, then the journal's own catch-up
 * read from the last write the reader saw. Messages are revised in place while they stream, so catch-up returns
 * every message written since, new or revised, and a reader replaces messages by id. */

import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { OrchestrationError } from './orchestration-error'
import {
  readStructuredJournalChanges,
  structuredJournalPage,
  type StructuredJournalPage
} from './structured-worker-journal-page'
import { boundWorkerTranscriptMessages } from './worker-transcript-payload'

export type StructuredJournalRead = {
  messages: NativeChatMessage[]
  next: AgentJournalCursor
  clipping: string[]
  warnings: string[]
}

/** The newest messages, with a cursor at the journal's current write. */
export function readStructuredJournalTail(
  page: StructuredJournalPage,
  limit: number
): StructuredJournalRead {
  const messages = projectStructuredItemsToNativeChat(page.items)
  // Bound newest-first so the size limit drops the oldest candidates, never the latest progress.
  const bounded = boundWorkerTranscriptMessages(messages.slice(-limit).toReversed())
  const olderOmitted = bounded.messages.length < messages.length || page.hasOlder
  return {
    messages: bounded.messages.toReversed(),
    next: page.liveCursor,
    clipping: [
      ...(olderOmitted ? ['message_limit_or_scan_window'] : []),
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

/** Messages written after `cursor`, in transcript order; `limit` bounds the journal writes one page covers. */
export async function readStructuredJournalSince(
  sessionId: string,
  cursor: AgentJournalCursor,
  limit: number
): Promise<StructuredJournalRead> {
  for (let writes = limit; ; writes = Math.ceil(writes / 2)) {
    const result = await readStructuredJournalChanges(sessionId, cursor, writes)
    if (!result) {
      throw new OrchestrationError(
        'transcript_required',
        'The worker transcript could not be read; its session is not attached.'
      )
    }
    if (!result.ok) {
      // A rebuilt or /clear-replaced journal cannot continue the cursor; its reset page is the newest messages.
      const tail = readStructuredJournalTail(structuredJournalPage(result.page), limit)
      return {
        ...tail,
        warnings: [
          'The transcript was rebuilt or cleared since this cursor; this page starts at its newest messages.',
          ...tail.warnings
        ]
      }
    }
    const page = result.page
    const messages = projectStructuredItemsToNativeChat(
      page.items.filter(isRootAgentJournalItem).toSorted(byJournalPosition)
    )
    const bounded = boundWorkerTranscriptMessages(messages)
    // Cover fewer writes rather than advance the cursor past messages the size limit dropped.
    if (bounded.messages.length < messages.length && writes > 1) {
      continue
    }
    return {
      messages: bounded.messages,
      next: page.window.nextCursor,
      clipping: [
        ...(page.hasNewer ? ['message_limit_or_scan_window'] : []),
        ...(bounded.limited ? ['transcript_payload'] : [])
      ],
      warnings: [
        ...bounded.warnings,
        ...(page.removedItemIds.length > 0
          ? ['Messages read earlier were removed from the transcript.']
          : [])
      ]
    }
  }
}

function byJournalPosition(left: AgentJournalRenderItem, right: AgentJournalRenderItem): number {
  return left.sequence - right.sequence || (left.sequenceIndex ?? 0) - (right.sequenceIndex ?? 0)
}
