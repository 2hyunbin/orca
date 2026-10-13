// The one bound on a conversation's queue: the bytes its cards publish. There is no card count
// limit; the cards ride every hydrating frame and history answer.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import { MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { jsonBytes } from './json-string-shortening'
import { publishedQueuedMessage } from './structured-agent-session-queued-publication'

/** A frame bound, not a queue limit: admitted cards fit the rows' share of one bounded frame, so a
 *  phone receives every card whole. Whole cards are counted, so many small cards are bounded as
 *  surely as a few large ones. */
export const QUEUED_MESSAGES_PUBLISHED_MAX_BYTES = HISTORY_PAGE_CONTENT_BUDGET_BYTES

/** Kept free of other agents' cards, so they alone never refuse a person's message: the largest
 *  message's blocks plus its card's own fields. */
export const QUEUED_MESSAGES_PERSON_RESERVE_BYTES = MAX_PROMPT_BYTES + 1024

/** Every card the queue publishes now or can publish again without passing admission: waiting and
 *  returned cards, and sent ones whose delivery is not yet accepted, which a Stop or a restart puts
 *  back in line. */
function cardsInLine(journal: AgentSessionJournal): AgentSessionQueuedMessage[] {
  return journal.queuedMessages.list().flatMap((row) => {
    if (row.state !== 'dispatched') {
      return publishedQueuedMessage(row) ?? []
    }
    const delivery = row.consumedAs === null ? undefined : journal.submission(row.consumedAs)
    return delivery?.dispatchState === 'accepted'
      ? []
      : (publishedQueuedMessage({ ...row, state: 'waiting' }) ?? [])
  })
}

/** Refused readably rather than trimmed, when the cards in line would outgrow their frame room.
 *  Another agent's card must also leave the person's reserve free. A card already in line is an
 *  edit: the new body takes the old one's place. */
export function queuedMessagesPublishedBytesRefusal(
  journal: AgentSessionJournal,
  card: QueuedCardDraft,
  fromPerson: boolean
): AgentSessionWireRefusal | null {
  const inLine = cardsInLine(journal)
  const edited = inLine.some((other) => other.messageId === card.messageId)
  const published = edited
    ? inLine.map((other) =>
        other.messageId === card.messageId ? { ...other, body: card.body } : other
      )
    : [...inLine, newQueuedCard(card)]
  const limit = fromPerson
    ? QUEUED_MESSAGES_PUBLISHED_MAX_BYTES
    : QUEUED_MESSAGES_PUBLISHED_MAX_BYTES - QUEUED_MESSAGES_PERSON_RESERVE_BYTES
  return jsonBytes(published) > limit
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
