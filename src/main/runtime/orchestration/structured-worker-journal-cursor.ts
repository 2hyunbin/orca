/** Read a live structured journal for worker-read: the newest messages first, then the journal's own catch-up
 * read from the last write the reader saw. Messages are revised in place while they stream, so catch-up returns
 * every message written since, new or revised, and a reader replaces messages by id. */

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
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

/** Up to `limit` messages written after `cursor`, in transcript order. */
export async function readStructuredJournalSince(
  sessionId: string,
  cursor: AgentJournalCursor,
  limit: number
): Promise<StructuredJournalRead> {
  // Streaming saves a message many times a second, so start wide and narrow by writes until the messages fit.
  for (let writes = AGENT_SESSION_HISTORY_MAX_LIMIT; ; writes = Math.ceil(writes / 2)) {
    const result = await readStructuredJournalChanges(sessionId, cursor, writes)
    if (!result) {
      throw new OrchestrationError(
        'transcript_required',
        'The worker transcript could not be read; its session is not attached.'
      )
    }
    if (!result.ok) {
      // A journal that cannot continue this cursor answers with its newest messages.
      const tail = readStructuredJournalTail(structuredJournalPage(result.page), limit)
      return {
        ...tail,
        warnings: [
          `The transcript cannot continue from this cursor (${result.reset}); this page starts at its newest messages.`,
          ...tail.warnings
        ]
      }
    }
    const page = result.page
    const messages = projectStructuredItemsToNativeChat(page.items.filter(isRootAgentJournalItem))
    const bounded = boundWorkerTranscriptMessages(messages)
    // Narrow rather than advance the cursor past messages the page cannot hold.
    if ((messages.length > limit || bounded.messages.length < messages.length) && writes > 1) {
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
          ? [
              'Some transcript items were removed since this cursor; read without --cursor for the current transcript.'
            ]
          : [])
      ]
    }
  }
}
