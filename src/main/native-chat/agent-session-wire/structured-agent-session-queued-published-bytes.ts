// The one bound on a conversation's queue: the bytes its published cards weigh. There is no card
// count limit; the cards ride every hydrating frame and history answer.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import { MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { jsonBytes } from './json-string-shortening'
import { publishedQueuedMessage } from './structured-agent-session-queued-publication'
import { unsettledQueuedMessages } from './structured-agent-session-queued-stop'

/** A frame bound, not a queue limit: the whole published list fits the rows' share of one bounded
 *  frame, so a phone always receives every card whole. Whole cards are counted, not just text, so
 *  many small cards are bounded as surely as a few large ones. */
export const QUEUED_MESSAGES_PUBLISHED_MAX_BYTES = HISTORY_PAGE_CONTENT_BUDGET_BYTES

/** Kept free of other agents' cards, so they alone never refuse a person's message: the largest
 *  message's blocks plus its card's own fields. */
export const QUEUED_MESSAGES_PERSON_RESERVE_BYTES = MAX_PROMPT_BYTES + 1024

/** Refused readably rather than trimmed, when the published cards would outgrow their frame room.
 *  Another agent's card must also leave the person's reserve free. A card already in the queue is
 *  an edit: the new body takes the old one's place. */
export function queuedMessagesPublishedBytesRefusal(
  journal: AgentSessionJournal,
  card: { messageId: string; body: AgentJournalMessageItem },
  fromPerson: boolean
): AgentSessionWireRefusal | null {
  let edited = false
  const bytes = unsettledQueuedMessages(journal).reduce((sum, row) => {
    const published = publishedQueuedMessage(row)
    if (published === null) {
      return sum
    }
    const replaced = row.messageId === card.messageId
    edited ||= replaced
    // +1 for the list separator.
    return sum + jsonBytes(replaced ? { ...published, body: card.body } : published) + 1
  }, 0)
  const total = edited ? bytes : bytes + newQueuedCardBytes(card)
  const limit = fromPerson
    ? QUEUED_MESSAGES_PUBLISHED_MAX_BYTES
    : QUEUED_MESSAGES_PUBLISHED_MAX_BYTES - QUEUED_MESSAGES_PERSON_RESERVE_BYTES
  return total > limit
    ? refuse(
        'agent_session_operation_invalid',
        { reason: 'queueTooLarge' },
        "Too much text is waiting in this chat's queue. Delete a queued message or wait for one to go through."
      )
    : null
}

/** What a new card adds to the published list at its widest: waiting, at the last position. */
export function newQueuedCardBytes(card: {
  messageId: string
  body: AgentJournalMessageItem
}): number {
  // +1 for the list separator.
  return jsonBytes({ ...card, position: Number.MAX_SAFE_INTEGER, state: 'waiting' }) + 1
}
