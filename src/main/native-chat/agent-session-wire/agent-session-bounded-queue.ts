// The draft queue as a bounded-frame subscriber receives it.
//
// Admission keeps the cards in line within the rows' share of one frame, so the list arrives whole.
// It can still be over: a queue an older build admitted under its larger bound, or cards that grew
// after admission (a failed send adds its reason). The list then carries the cards it sends first,
// whole; the rest show once those leave. A card is never shortened: a reader that edits one
// replaces the draft with what it holds.

import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { jsonBytes } from './json-string-shortening'
import type { QueuePublication } from './structured-agent-session-queued-publication'

export function boundedQueuePublication(publication: QueuePublication): QueuePublication {
  const cards = publication.queuedMessages
  if (jsonBytes(cards) <= HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
    return publication
  }
  // The longest run from the front that fits.
  let fits = 0
  let fitsNot = cards.length
  while (fitsNot - fits > 1) {
    const middle = Math.floor((fits + fitsNot) / 2)
    if (jsonBytes(cards.slice(0, middle)) <= HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
      fits = middle
    } else {
      fitsNot = middle
    }
  }
  const queuedMessages = cards.slice(0, fits)
  const listed = queuedMessages.some((card) => card.messageId === publication.nextQueuedMessageId)
  return {
    ...publication,
    queuedMessages,
    nextQueuedMessageId: listed ? publication.nextQueuedMessageId : null
  }
}
