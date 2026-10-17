// One journal item as every client receives it.
//
// The journal keeps tool output and diffs whole. A client is sent a head of each and the item is
// marked `shortened`; it fetches the whole item with `agentSession.item` when the user asks. Every
// other field is sent as kept. An item still past half a page is shortened to fit and marked
// rather than replaced, so its row and its "show full" stay readable.

import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { utf8Head } from '../agent-session-journal/journal-payload-bounds'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  type HistoryReader
} from './agent-session-history-page-bounds'
import { jsonBytes, shortenJsonStringsToFit } from './json-string-shortening'

/** Each tool output or diff as sent: the head older clients have always been sent. */
export const AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES = 16 * 1024

/** Half a page, so an item and the submission it carries always fit one. */
const CLIENT_ITEM_MAX_BYTES = HISTORY_PAGE_CONTENT_BUDGET_BYTES / 2

/** The payload as sent; itself when its head already fits. */
function wirePayload(payload: AgentJournalBoundedPayload): AgentJournalBoundedPayload {
  // UTF-8 spends at most three bytes per UTF-16 unit, so most heads fit without encoding.
  if (
    payload.head.length * 3 <= AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES ||
    Buffer.byteLength(payload.head, 'utf8') <= AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES
  ) {
    return payload
  }
  return {
    ...payload,
    head: utf8Head(payload.head, AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES),
    truncated: true
  }
}

function wireBody(body: AgentJournalItemBody): AgentJournalItemBody {
  if (body.kind === 'tool-call' && body.output) {
    const output = wirePayload(body.output)
    return output === body.output ? body : { ...body, output }
  }
  if (body.kind === 'diff') {
    const patch = wirePayload(body.patch)
    return patch === body.patch ? body : { ...body, patch }
  }
  return body
}

/** `item` fitted to `maxBytes`: its long strings shortened and the item marked. Null when even
 *  that cannot fit, which the page answers with its too-large marker. */
export function shortenedAgentJournalItem(
  item: AgentJournalRenderItem,
  maxBytes: number
): AgentJournalRenderItem | null {
  if (jsonBytes(item) <= maxBytes) {
    return item
  }
  const body = shortenJsonStringsToFit(
    item.body,
    maxBytes - (jsonBytes({ ...item, body: null, shortened: true }) - jsonBytes(null))
  )
  return body === null ? null : { ...item, body, shortened: true }
}

function wireItem(item: AgentJournalRenderItem): AgentJournalRenderItem {
  const body = wireBody(item.body)
  const sent = body === item.body ? item : { ...item, body, shortened: true as const }
  return shortenedAgentJournalItem(sent, CLIENT_ITEM_MAX_BYTES) ?? sent
}

// Items are immutable per revision, so a catch-up or a second subscriber reuses the sent form.
const sentForms = new WeakMap<AgentJournalRenderItem, AgentJournalRenderItem>()

/** What a client is sent of `item`. */
export function agentJournalItemForWire(item: AgentJournalRenderItem): AgentJournalRenderItem {
  let sent = sentForms.get(item)
  if (sent === undefined) {
    sent = wireItem(item)
    sentForms.set(item, sent)
  }
  return sent
}

/** How a desktop or paired client reads history: each item in its sent form. */
export const CLIENT_HISTORY_READER: HistoryReader = {
  form: agentJournalItemForWire,
  budgetBytes: HISTORY_PAGE_CONTENT_BUDGET_BYTES
}
