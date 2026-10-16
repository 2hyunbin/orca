import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { isSubagentBlock } from '../../../shared/native-chat-types'
import {
  agentJournalSubmissionKey,
  boundJournalKeyComponent
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime-memory-limits'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'
import { AGENT_SESSION_HISTORY_DEFAULT_LIMIT, AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import { agentSessionHostStatusBody } from '../../../shared/agent-session-host-status-rows'
import { subagentFoldKey, subagentItemBlock } from '../../../shared/native-chat-subagent-items'

export const AGENT_SESSION_HISTORY_MAX_PAGE_BYTES = REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES / 2

/** Clamping lets a reader keep paging instead of rejecting an excessive request. */
export function resolveHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return AGENT_SESSION_HISTORY_DEFAULT_LIMIT
  }
  return Math.min(AGENT_SESSION_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

const HISTORY_PAGE_ENVELOPE_RESERVE_BYTES = 64 * 1024

export const HISTORY_PAGE_CONTENT_BUDGET_BYTES =
  AGENT_SESSION_HISTORY_MAX_PAGE_BYTES - HISTORY_PAGE_ENVELOPE_RESERVE_BYTES

/** Everything a bounded frame carries beside its rows: the bridge envelope, ids and cursors, the
 *  subagent roster, the latest turn and the activity line, each held to its own bound. */
const FRAME_METADATA_CEILING_BYTES = 64 * 1024

/** The rows' share of a phone's bridge frame, which its app ends a stream over. */
export const BOUNDED_FRAME_CONTENT_BUDGET_BYTES =
  MOBILE_BRIDGE_MAX_FRAME_BYTES - FRAME_METADATA_CEILING_BYTES

export function historyEntryBytes(
  item: AgentJournalRenderItem,
  submissionBytes: ReadonlyMap<string, number>
): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8') + (submissionBytes.get(item.itemId) ?? 0)
}

// Keyed on the snapshot's own submissions array, which the reducer rebuilds on
// every change, so a paged read over one snapshot serializes submissions once.
const bytesBySubmissions = new WeakMap<
  readonly AgentJournalSubmission[],
  ReadonlyMap<string, number>
>()

export function submissionBytesByItemId(
  submissions: readonly AgentJournalSubmission[]
): ReadonlyMap<string, number> {
  const cached = bytesBySubmissions.get(submissions)
  if (cached) {
    return cached
  }
  const bytes = new Map(
    submissions.map((submission) => [
      agentJournalSubmissionKey(submission.clientMessageId),
      Buffer.byteLength(JSON.stringify(submission), 'utf8')
    ])
  )
  bytesBySubmissions.set(submissions, bytes)
  return bytes
}

export function oversizedHistoryItem(item: AgentJournalRenderItem): AgentJournalRenderItem {
  return {
    ...item,
    itemId: boundJournalKeyComponent(item.itemId),
    body: agentSessionHostStatusBody('history-item-too-large')
  }
}

/** How a reader receives each item, and the bytes its page may hold of them. A page is measured
 *  in that form, so it carries what it will actually send. */
export type HistoryReader = {
  form: (item: AgentJournalRenderItem) => AgentJournalRenderItem
  budgetBytes: number
}

export const STORED_HISTORY_READER: HistoryReader = {
  form: (item) => item,
  budgetBytes: HISTORY_PAGE_CONTENT_BUDGET_BYTES
}

/** Rows are put in `form` only as the page takes them. */
export function boundHistoryItemsByBytes(
  items: AgentJournalRenderItem[],
  keep: 'newest' | 'oldest',
  submissionBytes: ReadonlyMap<string, number>,
  maxBytes: number,
  form: HistoryReader['form'] = STORED_HISTORY_READER.form
): { items: AgentJournalRenderItem[]; dropped: number } {
  const ordered = groupItemsBySequence(items, keep)
  const kept: AgentJournalRenderItem[][] = []
  let total = 0
  for (const stored of ordered) {
    const group = stored.map(form)
    const bytes = group.reduce((sum, item) => sum + historyEntryBytes(item, submissionBytes), 0)
    if (kept.length === 0 && bytes > maxBytes) {
      kept.push(group.map((item) => oversizedHistoryItem(item)))
      break
    }
    if (total + bytes > maxBytes) {
      break
    }
    kept.push(group)
    total += bytes
  }
  return {
    items: (keep === 'newest' ? kept.toReversed() : kept).flat(),
    dropped: items.length - kept.reduce((count, group) => count + group.length, 0)
  }
}

/** Adjacent same-sequence runs, walked from the end (`newest`) or the start (`oldest`)
 *  so a caller that stops at its window never groups the history it will not return.
 *  Groups and their items keep the order the eager forward grouping produced. */
function* groupItemsBySequence(
  items: readonly AgentJournalRenderItem[],
  keep: 'newest' | 'oldest'
): Generator<AgentJournalRenderItem[]> {
  let cursor = keep === 'newest' ? items.length : 0
  while (keep === 'newest' ? cursor > 0 : cursor < items.length) {
    if (keep === 'newest') {
      let start = cursor - 1
      const sequence = items[start].sequence
      while (start > 0 && items[start - 1].sequence === sequence) {
        start -= 1
      }
      yield items.slice(start, cursor)
      cursor = start
    } else {
      let end = cursor + 1
      const sequence = items[cursor].sequence
      while (end < items.length && items[end].sequence === sequence) {
        end += 1
      }
      yield items.slice(cursor, end)
      cursor = end
    }
  }
}

export function newestWholeSequenceGroups(
  items: readonly AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  const selected: AgentJournalRenderItem[][] = []
  let count = 0
  for (const group of groupItemsBySequence(items, 'newest')) {
    if (selected.length > 0 && count + group.length > limit) {
      break
    }
    selected.push(group)
    count += group.length
  }
  return selected.toReversed().flat()
}

/** `start` moved back to the first sibling of every subagent group the window holds part of, but
 *  never past `floor`: a group spread over a long turn, or helpers outside any turn, may still
 *  split rather than grow the page without bound. */
export function wholeSubagentGroupsStart(
  items: readonly AgentJournalRenderItem[],
  start: number,
  floor: number
): number {
  const firstOf = new Map<string, number>()
  for (const item of items) {
    const block = item.body.kind === 'message' ? subagentItemBlock(item.body) : null
    if (block !== null && !firstOf.has(subagentFoldKey(block))) {
      firstOf.set(subagentFoldKey(block), item.sequence)
    }
  }
  let whole = start
  for (let index = items.length - 1; index >= 0 && items[index]!.sequence >= whole; index--) {
    const item = items[index]!
    const block = item.body.kind === 'message' ? subagentItemBlock(item.body) : null
    if (block !== null) {
      whole = Math.max(floor, Math.min(whole, firstOf.get(subagentFoldKey(block))!))
    }
  }
  return whole
}

/**
 * The newest `limit` of the session's own rows, in whole sequence groups, and every
 * row after the oldest of them: a subagent's rows, and each subagent's own row, ride
 * along with the conversation they happened in, so a burst or a fan-out cannot crowd
 * the conversation off the page. The page stays contiguous and starts at its first
 * item, as the cursor means; the byte budget still bounds it. Fewer own rows than
 * `limit` reach back to the start. With no subagent rows this is the newest `limit`
 * rows, as before. A page reaches back to the first sibling of each subagent group it holds
 * part of, so loading an older page does not renumber a group's ordinals or move its row.
 */
export function conversationWindow(
  items: readonly AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  const own = items.filter((item) => isRootAgentJournalItem(item) && !isSubagentRow(item))
  if (own.length === items.length) {
    return newestWholeSequenceGroups(items, limit)
  }
  const ownWindow = newestWholeSequenceGroups(own, limit)
  const start = ownWindow.length < own.length ? ownWindow[0]?.sequence : undefined
  if (start === undefined) {
    return [...items]
  }
  const reach = newestWholeSequenceGroups(own, 2 * limit)
  const floor = reach.length < own.length ? reach[0]!.sequence : Number.NEGATIVE_INFINITY
  const whole = wholeSubagentGroupsStart(items, start, floor)
  return items.filter((item) => item.sequence >= whole)
}

function isSubagentRow(item: AgentJournalRenderItem): boolean {
  return item.body.kind === 'message' && item.body.blocks.some(isSubagentBlock)
}
