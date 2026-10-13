// The draft queue as a bounded-frame subscriber receives it.
//
// Admission keeps the published list within the rows' share of one frame, so it arrives whole. Only
// a queue admitted by an older build under its larger bound can be over: each card is then a
// preview of an equal share, marked `truncated`, which a reader must not edit in place, and a queue
// of more cards than fit even so lists the ones it sends first.

import type { AgentSessionQueuedMessage } from '../../../shared/agent-session-wire'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { jsonBytes, shortenJsonStringsToFit } from './json-string-shortening'
import type { QueuePublication } from './structured-agent-session-queued-publication'

/** The mark a shortened card carries, at its widest. */
const TRUNCATED_MARK_BYTES = jsonBytes({ truncated: { byteLength: Number.MAX_SAFE_INTEGER } })

function previewCard(card: AgentSessionQueuedMessage, maxBytes: number): AgentSessionQueuedMessage {
  const fitted = shortenJsonStringsToFit(card, maxBytes - TRUNCATED_MARK_BYTES)
  if (fitted === card) {
    return card
  }
  const truncated = { byteLength: jsonBytes(card) }
  // Only fields too short to shorten remain: the card keeps what places it.
  const { messageId, position, state, body } = card
  return fitted === null
    ? {
        messageId,
        position,
        state,
        body: { kind: 'message', role: body.role, blocks: [] },
        truncated
      }
    : { ...fitted, truncated }
}

export function boundedQueuePublication(publication: QueuePublication): QueuePublication {
  const cards = publication.queuedMessages
  if (jsonBytes(cards) <= HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
    return publication
  }
  // -1 per card for its list separator.
  const share = Math.floor(HISTORY_PAGE_CONTENT_BUDGET_BYTES / cards.length) - 1
  const previews = cards.map((card) => previewCard(card, share))
  return { ...publication, queuedMessages: leadingCardsThatFit(previews) }
}

/** Cards too many to fit even as their smallest previews: the ones the queue sends first. */
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
