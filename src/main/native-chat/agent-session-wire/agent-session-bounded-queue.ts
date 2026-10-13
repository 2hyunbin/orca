// The draft queue as a bounded-frame subscriber receives it.
//
// Admission sizes every card at its widest and keeps the list within the rows' share of one frame,
// so it arrives whole. A queue saved by an older build under its larger bound can still be over: its
// long text is then cut to one common length and each card it cut is marked `truncated`, which a
// reader must not edit in place. A queue of more cards than fit even so lists the ones it sends
// first.

import type { AgentSessionQueuedMessage } from '../../../shared/agent-session-wire'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { jsonBytes, shortenJsonStringsToFit } from './json-string-shortening'
import type { QueuePublication } from './structured-agent-session-queued-publication'

/** What the mark adds to a shortened card. */
const TRUNCATED_MARK_BYTES = Buffer.byteLength(',"truncated":true', 'utf8')

/** A card with nothing left to cut: what places it, and an empty body. */
function emptiedCard(card: AgentSessionQueuedMessage): AgentSessionQueuedMessage {
  const { messageId, position, state, body } = card
  return { messageId, position, state, body: { kind: 'message', role: body.role, blocks: [] } }
}

function markedCut(
  cards: readonly AgentSessionQueuedMessage[],
  cut: readonly AgentSessionQueuedMessage[]
): AgentSessionQueuedMessage[] {
  return cut.map((card, index) =>
    card === cards[index] ? card : { ...card, truncated: true as const }
  )
}

/** The longest run from the front that fits. */
function leadingCardsThatFit(cards: AgentSessionQueuedMessage[]): AgentSessionQueuedMessage[] {
  let fits = 0
  let fitsNot = cards.length + 1
  while (fitsNot - fits > 1) {
    const middle = Math.floor((fits + fitsNot) / 2)
    if (jsonBytes(cards.slice(0, middle)) <= HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
      fits = middle
    } else {
      fitsNot = middle
    }
  }
  return cards.slice(0, fits)
}

export function boundedQueuePublication(publication: QueuePublication): QueuePublication {
  const cards = publication.queuedMessages
  if (jsonBytes(cards) <= HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
    return publication
  }
  const room = HISTORY_PAGE_CONTENT_BUDGET_BYTES - cards.length * TRUNCATED_MARK_BYTES
  const cut = shortenJsonStringsToFit(cards, room)
  const queuedMessages = cut
    ? markedCut(cards, cut)
    : leadingCardsThatFit(markedCut(cards, cards.map(emptiedCard)))
  const listed = queuedMessages.some((card) => card.messageId === publication.nextQueuedMessageId)
  return {
    ...publication,
    queuedMessages,
    nextQueuedMessageId: listed ? publication.nextQueuedMessageId : null
  }
}
