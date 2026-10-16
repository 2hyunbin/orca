// Paged history over one journal.
//
// `tail` and `before` read the REDUCED timeline, so backward paging keeps
// working after compaction — the folded snapshot still holds every live item.
// `after` is the catch-up direction and must read rows instead: an item created
// early and revised late orders by its creation sequence, so an item-window
// read would silently skip that revision. Rows carry the revision, which is why
// `after` is the only direction that can answer `cursor_compacted`.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { latestStructuredAgentSessionTurn } from '../../../shared/structured-agent-session-live-turn'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryDirection,
  type AgentSessionHistoryPage,
  type AgentSessionHistoryRequest,
  type AgentSessionHistoryResult,
  type AgentSessionLatestTurn,
  type AgentSessionSubagentRosterEntry
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { projectJournalBatch } from './agent-session-journal-batch'
import {
  boundHistoryItemsByBytes,
  STORED_HISTORY_READER,
  type HistoryReader,
  historyEntryBytes,
  conversationWindow,
  oversizedHistoryItem,
  submissionBytesByItemId,
  resolveHistoryLimit
} from './agent-session-history-page-bounds'
import { offPageSubagentRoster } from './agent-session-history-subagent-roster'

export { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES, resolveHistoryLimit } from './agent-session-history-page-bounds'

export type AgentSessionHistoryPublication = ReturnType<AgentSessionJournal['capturePublication']>

/** Whose rows a backward read serves. Both window over the session's own rows; a
 *  reader of the session's own agent alone gets only those. In-process only: no wire
 *  request carries it. */
export type AgentSessionHistoryScope = 'every-agent' | 'own-agent'

export function readAgentSessionHistory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest,
  {
    publication,
    snapshot = publication?.snapshot ?? journal.snapshot(),
    scope = 'every-agent',
    reader = STORED_HISTORY_READER
  }: {
    /** Reduced state to read against. A synchronous multi-page catch-up passes one
     *  snapshot for the whole run so each page costs its own rows, not the timeline. */
    snapshot?: AgentJournalSnapshot
    scope?: AgentSessionHistoryScope
    reader?: HistoryReader
    publication?: AgentSessionHistoryPublication
  } = {}
): AgentSessionHistoryResult {
  const limit = resolveHistoryLimit(request.limit)
  if (request.direction === 'after') {
    return readForward(journal, snapshot, request.cursor, limit, reader, publication)
  }
  const cursor = request.direction === 'before' ? request.cursor : undefined
  if (cursor) {
    if (cursor.epoch !== snapshot.cursor.epoch) {
      return historyReset(snapshot, 'epoch_changed', reader)
    }
    if (cursor.sequence > snapshot.cursor.sequence) {
      return historyReset(snapshot, 'cursor_ahead', reader)
    }
  }
  const scoped =
    scope === 'own-agent' ? snapshot.items.filter(isRootAgentJournalItem) : snapshot.items
  const older = cursor ? scoped.filter((item) => item.sequence < cursor.sequence) : scoped
  const windowed = conversationWindow(older, limit)
  const { items, dropped } = boundHistoryItemsByBytes(
    windowed,
    'newest',
    submissionBytesByItemId(snapshot.submissions),
    reader.budgetBytes,
    reader.form
  )
  return {
    ok: true,
    page: buildPage({
      snapshot,
      direction: request.direction,
      items,
      hasOlder: older.length > windowed.length || dropped > 0,
      hasNewer: older.length < scoped.length,
      fallbackCursor: cursor ?? { epoch: snapshot.cursor.epoch, sequence: 0 },
      nextCursor: items[0]
        ? { epoch: snapshot.cursor.epoch, sequence: items[0].sequence }
        : undefined,
      subagentRoster: offPageSubagentRoster(scoped, items)
    })
  }
}

/**
 * A catch-up run over one journal. Pages share one reduced timeline, so the run
 * costs its own rows instead of re-reducing every item per page; the cursor
 * check re-reduces if anything did advance the journal between pages.
 */
export function createAgentSessionCatchUpReader(
  journal: AgentSessionJournal,
  reader: HistoryReader = STORED_HISTORY_READER,
  publication?: AgentSessionHistoryPublication
): (request: AgentSessionHistoryRequest) => AgentSessionHistoryResult {
  let snapshot = publication?.snapshot ?? journal.snapshot()
  return (request) => {
    const live = journal.cursor()
    if (!publication && (live.epoch !== snapshot.cursor.epoch || live.sequence !== snapshot.cursor.sequence)) {
      snapshot = journal.snapshot()
    }
    return readAgentSessionHistory(journal, request, { snapshot, reader, publication })
  }
}

export function readAgentSessionHydrationPage(
  journal: AgentSessionJournal,
  fence?: number,
  reader: HistoryReader = STORED_HISTORY_READER,
  snapshot = journal.snapshot()
): AgentSessionHistoryPage {
  return buildHydrationPage(snapshot, fence, reader)
}

function buildHydrationPage(
  snapshot: AgentJournalSnapshot,
  fence: number | undefined,
  reader: HistoryReader
): AgentSessionHistoryPage {
  const items = conversationWindow(snapshot.items, AGENT_SESSION_HISTORY_MAX_LIMIT)
  const bounded = boundHistoryItemsByBytes(
    items,
    'newest',
    submissionBytesByItemId(snapshot.submissions),
    reader.budgetBytes,
    reader.form
  )
  return buildPage({
    snapshot,
    direction: 'tail',
    items: bounded.items,
    hasOlder: snapshot.items.length > items.length || bounded.dropped > 0,
    hasNewer: false,
    fallbackCursor: { epoch: snapshot.cursor.epoch, sequence: 0 },
    nextCursor: bounded.items[0]
      ? { epoch: snapshot.cursor.epoch, sequence: bounded.items[0].sequence }
      : undefined,
    fence,
    subagentRoster: offPageSubagentRoster(snapshot.items, bounded.items)
  })
}

function historyReset(
  snapshot: AgentJournalSnapshot,
  reset: Extract<AgentSessionHistoryResult, { ok: false }>['reset'],
  reader: HistoryReader
): AgentSessionHistoryResult {
  return {
    ok: false,
    reset,
    page: buildHydrationPage(snapshot, undefined, reader)
  }
}

function readForward(
  journal: AgentSessionJournal,
  snapshot: AgentJournalSnapshot,
  cursor: AgentJournalCursor | undefined,
  limit: number,
  reader: HistoryReader,
  publication?: AgentSessionHistoryPublication
): AgentSessionHistoryResult {
  if (!cursor) {
    // Why: forward paging replays rows after a position; without one there is
    // nothing to be after, and silently serving the tail would hand the client
    // a page it cannot place.
    return historyReset(snapshot, 'cursor_ahead', reader)
  }
  // One lookahead preserves hasNewer without rereading the entire remaining journal per page.
  const committed = publication?.rowsAfter(cursor, limit + 1)
  const since = committed
    ? { ok: true as const, rows: committed }
    : journal.readSince(cursor, limit + 1)
  if (!since.ok) {
    return historyReset(snapshot, since.reset, reader)
  }
  const submissionBytes = submissionBytesByItemId(snapshot.submissions)
  // The page cost is EVERYTHING variable it carries: items with their
  // submissions AND removal ids — a legal pre-bounding tombstone id can dwarf
  // every item on the page.
  const pageContentBytes = (
    items: readonly AgentJournalRenderItem[],
    removedItemIds: readonly string[]
  ): number =>
    items.reduce((total, item) => total + historyEntryBytes(item, submissionBytes), 0) +
    removedItemIds.reduce(
      (total, itemId) => total + Buffer.byteLength(JSON.stringify(itemId), 'utf8') + 1,
      0
    )
  // Rows replay forward, so the byte bound shrinks the ROW window rather than
  // clipping projected items: dropping an item while advancing the cursor past
  // the rows that touched it would lose that revision for good.
  const available = since.rows.filter((row) => row.seq <= snapshot.cursor.sequence)
  let rows = available.slice(0, limit)
  const project = (window: typeof rows): ReturnType<typeof projectJournalBatch> => {
    const result = projectJournalBatch({
      rows: window,
      snapshot,
      afterSequence: cursor.sequence,
      canonicalItemId: publication?.canonicalItemId ?? journal.canonicalItemId
    })
    return result.ok
      ? { ...result, batch: { ...result.batch, items: result.batch.items.map(reader.form) } }
      : result
  }
  let projected = project(rows)
  if (!projected.ok) {
    return historyReset(snapshot, projected.reset, reader)
  }
  let contentBytes = pageContentBytes(projected.batch.items, projected.batch.removedItemIds)
  while (rows.length > 1 && contentBytes > reader.budgetBytes) {
    rows = rows.slice(0, Math.ceil(rows.length / 2))
    const shrunk = project(rows)
    if (!shrunk.ok) {
      return historyReset(snapshot, shrunk.reset, reader)
    }
    projected = shrunk
    contentBytes = pageContentBytes(projected.batch.items, projected.batch.removedItemIds)
  }
  // One row can still touch an over-budget item; degrade it visibly.
  let items = projected.batch.items
  if (contentBytes > reader.budgetBytes) {
    items = items.map((item) => {
      const bytes = historyEntryBytes(item, submissionBytes)
      return bytes > reader.budgetBytes ? oversizedHistoryItem(item) : item
    })
    contentBytes = pageContentBytes(items, projected.batch.removedItemIds)
  }
  if (contentBytes > reader.budgetBytes) {
    // A single row's semantic payload — in practice a pre-bounding oversized
    // removal id — can never fit any page, and truncating a removal id would
    // break the client's keying. A bounded tail replaces the client's state
    // wholesale, which applies the removal without carrying the id, and the
    // client resumes from the live cursor past this row.
    return historyReset(snapshot, 'cursor_compacted', reader)
  }
  const lastSequence = rows.at(-1)?.seq ?? cursor.sequence
  return {
    ok: true,
    page: buildPage({
      snapshot,
      direction: 'after',
      items,
      removedItemIds: projected.batch.removedItemIds,
      // Reading after a position means there is something before it.
      hasOlder: cursor.sequence > 0,
      hasNewer: available.length > rows.length,
      fallbackCursor: cursor,
      nextCursor: { epoch: cursor.epoch, sequence: lastSequence }
    })
  }
}

function buildPage(input: {
  snapshot: AgentJournalSnapshot
  direction: AgentSessionHistoryDirection
  items: AgentJournalRenderItem[]
  removedItemIds?: string[]
  hasOlder: boolean
  hasNewer: boolean
  fallbackCursor: AgentJournalCursor
  nextCursor: AgentJournalCursor | undefined
  fence?: number
  subagentRoster?: AgentSessionSubagentRosterEntry[]
}): AgentSessionHistoryPage {
  const epoch = input.snapshot.cursor.epoch
  const pageItemIds = new Set(input.items.map((item) => item.itemId))
  const oldest = input.items[0]
  const newest = input.items.at(-1)
  return {
    sessionId: input.snapshot.sessionId,
    epoch,
    ...(input.fence !== undefined ? { fence: input.fence } : {}),
    direction: input.direction,
    items: input.items,
    removedItemIds: input.removedItemIds ?? [],
    submissions: input.snapshot.submissions.filter((submission) =>
      pageItemIds.has(agentJournalSubmissionKey(submission.clientMessageId))
    ),
    window: {
      oldest: oldest ? { epoch, sequence: oldest.sequence } : null,
      newest: newest ? { epoch, sequence: newest.sequence } : null,
      nextCursor: input.nextCursor ?? input.fallbackCursor
    },
    liveCursor: input.snapshot.cursor,
    hasOlder: input.hasOlder,
    hasNewer: input.hasNewer,
    ...(input.subagentRoster === undefined ? {} : { subagentRoster: input.subagentRoster }),
    // From the whole timeline, never the page: a long turn's record sits below any window.
    latestTurn: snapshotLatestTurn(input.snapshot)
  }
}

// A catch-up run pages one snapshot many times; its scan back to the turn record is paid once.
const latestTurnBySnapshot = new WeakMap<AgentJournalSnapshot, AgentSessionLatestTurn | null>()

export function snapshotLatestTurn(snapshot: AgentJournalSnapshot): AgentSessionLatestTurn | null {
  let latest = latestTurnBySnapshot.get(snapshot)
  if (latest === undefined) {
    latest = latestStructuredAgentSessionTurn(snapshot.items)
    latestTurnBySnapshot.set(snapshot, latest)
  }
  return latest
}
