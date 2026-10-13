// The one bound on a conversation's queue: the bytes its published cards weigh. There is no card
// count limit; the cards ride every hydrating frame and history answer.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import { MAX_PROVIDER_DIAGNOSTIC_CHARS } from '../../../shared/agent-session-failure'
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

/** What a failed send or a hold adds to a card: the refusal's words and fact, each quoting at most
 *  one provider detail (3 UTF-8 bytes a char), and their fields. */
export const QUEUED_CARD_STATUS_BYTES = 2 * 3 * MAX_PROVIDER_DIAGNOSTIC_CHARS + 1024

/** Kept free of other agents' cards, so they alone never refuse a person's message: the largest
 *  message's blocks plus its card's own fields at their widest. */
export const QUEUED_MESSAGES_PERSON_RESERVE_BYTES =
  MAX_PROMPT_BYTES + 1024 + QUEUED_CARD_STATUS_BYTES

/** Refused readably rather than trimmed, when the published cards would outgrow their frame room.
 *  Each card is sized at its widest, so a later failed send never pushes the list past it. Another
 *  agent's card must also leave the person's reserve free. A card already in the queue is an edit:
 *  the new body takes the old one's place. */
export function queuedMessagesPublishedBytesRefusal(
  journal: AgentSessionJournal,
  card: QueuedCardDraft,
  fromPerson: boolean
): AgentSessionWireRefusal | null {
  const others = unsettledQueuedMessages(journal).flatMap(
    (row) => publishedQueuedMessage(row) ?? []
  )
  const edited = others.some((other) => other.messageId === card.messageId)
  const published = edited
    ? others.map((other) =>
        other.messageId === card.messageId ? { ...other, body: card.body } : other
      )
    : [...others, newQueuedCard(card)]
  const limit = fromPerson
    ? QUEUED_MESSAGES_PUBLISHED_MAX_BYTES
    : QUEUED_MESSAGES_PUBLISHED_MAX_BYTES - QUEUED_MESSAGES_PERSON_RESERVE_BYTES
  const unreturned = published.filter((other) => other.state !== 'returned').length
  return jsonBytes(published) + unreturned * QUEUED_CARD_STATUS_BYTES > limit
    ? refuse(
        'agent_session_operation_invalid',
        { reason: 'queueTooLarge' },
        "Too much text is waiting in this chat's queue. Delete a queued message or wait for one to go through."
      )
    : null
}

type QueuedCardDraft = { messageId: string; body: AgentJournalMessageItem }

/** A new card: waiting, at the widest position. */
export function newQueuedCard(
  card: QueuedCardDraft
): QueuedCardDraft & { position: number; state: 'waiting' } {
  return { ...card, position: Number.MAX_SAFE_INTEGER, state: 'waiting' }
}
