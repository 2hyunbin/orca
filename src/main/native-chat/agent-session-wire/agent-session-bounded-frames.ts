// What a bounded-frame subscriber is sent: every frame fits a phone's bridge frame.
//
// A history frame carries its rows, sized by the page that read them, and metadata held to
// `FRAME_METADATA_CEILING_BYTES`. The lists that ride beside history on other subscribers' frames
// (the draft queue and the background-task roster) go in frames of their own, each fitted to the
// same content budget; the slash-command list is not sent, since a phone reads it from
// `agentSession.options`.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { boundedFrameItem } from './agent-session-bounded-frame-item'
import type { HistoryItemForm } from './agent-session-history-page'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { jsonBytes, shortenJsonStringsToFit } from './json-string-shortening'
import type { QueuePublication } from './structured-agent-session-queued-publication'
import { boundedQueuePublication } from './agent-session-bounded-queue'

/** How a subscriber's rows are read: bounded, or as stored when undefined. */
export function subscriberItemForm(subscriber: {
  boundedFrames: boolean
}): HistoryItemForm | undefined {
  return subscriber.boundedFrames ? boundedFrameItem : undefined
}

/** The latest turn and the activity line are each a few hundred bytes; past these, a frame leaves
 *  them out, which a reader takes as a host that did not say. */
export const BOUNDED_FRAME_LATEST_TURN_BYTES = 8 * 1024
export const BOUNDED_FRAME_ACTIVITY_BYTES = 2 * 1024

type HistoryFrame = Exclude<AgentSessionSubscribeEvent, { type: 'end' }>
type BatchFrame = Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
type SideFields = Pick<
  BatchFrame,
  'queuedMessages' | 'queuePause' | 'nextQueuedMessageId' | 'backgroundTasks'
>

function within<T>(value: T | null | undefined, maxBytes: number): boolean {
  return value === undefined || value === null || jsonBytes(value) <= maxBytes
}

/** The cursor a reader holds once it has applied `event`, which a side frame must name. */
function cursorAfter(event: HistoryFrame): AgentJournalCursor {
  return event.type === 'batch'
    ? event.batch.cursor
    : (event.page.liveCursor ?? event.page.window.nextCursor)
}

/** `event` without its side lists, its rows in bounded form, and over-bound metadata left out. */
function boundedHistoryFrame(event: HistoryFrame): HistoryFrame {
  const {
    commands: _commands,
    queuedMessages: _queuedMessages,
    queuePause: _queuePause,
    nextQueuedMessageId: _nextQueuedMessageId,
    backgroundTasks: _backgroundTasks,
    activity,
    ...rest
  } = event
  const kept = {
    ...rest,
    ...(activity !== undefined && within(activity, BOUNDED_FRAME_ACTIVITY_BYTES)
      ? { activity }
      : {})
  }
  if (kept.type === 'batch') {
    const { latestTurn, ...batch } = kept
    return {
      ...batch,
      batch: { ...batch.batch, items: batch.batch.items.map(boundedFrameItem) },
      ...(within(latestTurn, BOUNDED_FRAME_LATEST_TURN_BYTES) && latestTurn !== undefined
        ? { latestTurn }
        : {})
    }
  }
  const { latestTurn, ...page } = kept.page
  return {
    ...kept,
    page: {
      ...page,
      items: page.items.map(boundedFrameItem),
      ...(within(latestTurn, BOUNDED_FRAME_LATEST_TURN_BYTES) && latestTurn !== undefined
        ? { latestTurn }
        : {})
    }
  }
}

/** Rows a roster can leave out when its text alone will not fit, least telling first. */
const BACKGROUND_TASK_LISTS = ['settledTasks', 'children', 'tasks'] as const

/** The newer half of each list in turn until the roster fits; `incomplete` tells a reader that
 *  what is listed is not everything. */
function withoutOlderRows(state: AgentSessionBackgroundTaskState): AgentSessionBackgroundTaskState {
  let fitted = state
  for (const list of BACKGROUND_TASK_LISTS) {
    while (
      (fitted[list]?.length ?? 0) > 0 &&
      jsonBytes(fitted) > HISTORY_PAGE_CONTENT_BUDGET_BYTES
    ) {
      const rows = fitted[list] ?? []
      fitted = { ...fitted, [list]: rows.slice(Math.ceil(rows.length / 2)), incomplete: true }
    }
  }
  return fitted
}

/** The roster fitted to a frame: its text shortened, then older rows left out. */
export function boundedBackgroundTasks(
  state: AgentSessionBackgroundTaskState | null
): AgentSessionBackgroundTaskState | null {
  if (state === null) {
    return null
  }
  return (
    shortenJsonStringsToFit(state, HISTORY_PAGE_CONTENT_BUDGET_BYTES) ??
    shortenJsonStringsToFit(withoutOlderRows(state), HISTORY_PAGE_CONTENT_BUDGET_BYTES) ?? {
      state: state.state,
      incomplete: true
    }
  )
}

export type BoundedSideLists = {
  queued: QueuePublication | undefined
  backgroundTasks: AgentSessionBackgroundTaskState | null | undefined
}

/** One event as a bounded-frame subscriber receives it: the history frame, then a frame for each
 *  side list the event would have carried. */
export function boundedFrames(
  event: AgentSessionSubscribeEvent,
  side: BoundedSideLists
): AgentSessionSubscribeEvent[] {
  if (event.type === 'end') {
    return [event]
  }
  const sideFrame = (fields: SideFields): BatchFrame => ({
    type: 'batch',
    sessionId: event.sessionId,
    batch: emptyAgentSessionBatch(cursorAfter(event)),
    ...(event.fence === undefined ? {} : { fence: event.fence }),
    ...(event.hostNow === undefined ? {} : { hostNow: event.hostNow }),
    ...fields
  })
  return [
    boundedHistoryFrame(event),
    ...(side.queued === undefined ? [] : [sideFrame(boundedQueuePublication(side.queued))]),
    ...(side.backgroundTasks === undefined
      ? []
      : [sideFrame({ backgroundTasks: boundedBackgroundTasks(side.backgroundTasks) })])
  ]
}
