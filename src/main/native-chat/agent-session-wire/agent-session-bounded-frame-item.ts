// One journal item as a bounded-frame reader receives it: no more than the phone draws, and never
// more than one row's share of a frame.

import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { boundJournalKeyComponent } from '../../../shared/agent-session-journal-item-key'
import { MAX_DIFF_CHARS, rendersAsDiff } from '../../../shared/native-chat-diff'
import { MAX_TOOL_DETAIL_LENGTH } from '../../../shared/native-chat-tool-summary'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'
import { jsonBytes, shortenJsonStringsToFit } from './json-string-shortening'

/** One row's share of a page, so a page always carries several rows. */
export const BOUNDED_FRAME_ROW_BYTES = HISTORY_PAGE_CONTENT_BUDGET_BYTES / 8

/** A tool's output as the phone shows it: a diff in full, anything else to its detail length. */
function displayedOutput(payload: AgentJournalBoundedPayload): AgentJournalBoundedPayload {
  if (payload.head.length <= MAX_TOOL_DETAIL_LENGTH || rendersAsDiff(payload.head)) {
    return payload
  }
  return { ...payload, head: payload.head.slice(0, MAX_TOOL_DETAIL_LENGTH), truncated: true }
}

/** A tool's input as the phone shows it: every string to the length its diff view reads, plus
 *  the mark, so that view still ends in its truncation line. Unchanged input keeps its identity. */
function displayedInput(input: unknown): unknown {
  if (typeof input === 'string') {
    return input.length > MAX_DIFF_CHARS ? `${input.slice(0, MAX_DIFF_CHARS)}…` : input
  }
  if (typeof input !== 'object' || input === null) {
    return input
  }
  const entries = Object.entries(input)
  const displayed = entries.map(([key, value]) => [key, displayedInput(value)] as const)
  if (displayed.every(([, value], index) => value === entries[index]![1])) {
    return input
  }
  return Array.isArray(input) ? displayed.map(([, value]) => value) : Object.fromEntries(displayed)
}

function displayedBody(body: AgentJournalItemBody): AgentJournalItemBody {
  if (body.kind === 'diff') {
    const patch = displayedOutput(body.patch)
    return patch === body.patch ? body : { ...body, patch }
  }
  if (body.kind !== 'tool-call') {
    return body
  }
  const input = displayedInput(body.input)
  const output = body.output && displayedOutput(body.output)
  return input === body.input && output === body.output
    ? body
    : { ...body, input, ...(output ? { output } : {}) }
}

/** What the body may weigh once the rest of the row, and the mark a cut adds, are paid for. */
function bodyBudget(item: AgentJournalRenderItem): number {
  const widest = { ...item, body: null, truncated: { byteLength: Number.MAX_SAFE_INTEGER } }
  return BOUNDED_FRAME_ROW_BYTES - (jsonBytes(widest) - jsonBytes(null))
}

/** The too-large marker with every identifier it carries held to a key's bound, so the marker
 *  itself always fits a row. Provenance a reader never joins on is dropped. */
function oversizedFrameItem(item: AgentJournalRenderItem): AgentJournalRenderItem {
  const {
    providerParentRef: _provenance,
    agentId,
    parentAgentId,
    turnScope,
    ...marker
  } = oversizedHistoryItem(item)
  return {
    ...marker,
    ...(agentId === undefined ? {} : { agentId: boundJournalKeyComponent(agentId) }),
    ...(parentAgentId === undefined
      ? {}
      : { parentAgentId: boundJournalKeyComponent(parentAgentId) }),
    ...(turnScope?.kind === 'turn'
      ? { turnScope: { kind: 'turn', turnItemId: boundJournalKeyComponent(turnScope.turnItemId) } }
      : turnScope === undefined
        ? {}
        : { turnScope })
  }
}

function boundFrameItem(item: AgentJournalRenderItem): AgentJournalRenderItem {
  const body = shortenJsonStringsToFit(displayedBody(item.body), bodyBudget(item))
  if (body === null) {
    return oversizedFrameItem(item)
  }
  return body === item.body ? item : { ...item, body, truncated: { byteLength: jsonBytes(item) } }
}

// Items are immutable per revision, so a catch-up or a second subscriber reuses the bound form.
const bounded = new WeakMap<AgentJournalRenderItem, AgentJournalRenderItem>()

export function boundedFrameItem(item: AgentJournalRenderItem): AgentJournalRenderItem {
  let result = bounded.get(item)
  if (result === undefined) {
    result = boundFrameItem(item)
    bounded.set(item, result)
    // Bounding is idempotent, so a frame that bounds an already-bounded row pays nothing.
    bounded.set(result, result)
  }
  return result
}
