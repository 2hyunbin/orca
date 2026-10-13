// What a bounded-frame subscriber is sent: every frame fits a phone's bridge frame.
//
// A history frame carries rows its reader already sized in bounded form, and metadata held to
// `FRAME_METADATA_CEILING_BYTES`. The lists that ride beside history on other subscribers' frames
// (the draft queue and the background-task roster) each ride an empty batch of their own, fitted to
// the same content budget; the slash-command list is not sent, since a phone reads it from
// `agentSession.options`.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { boundedFrameItem } from './agent-session-bounded-frame-item'
import { boundedQueuePublication } from './agent-session-bounded-queue'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { asStoredHistoryItem, type HistoryItemForm } from './agent-session-history-page'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { jsonBytes, shortenJsonStringsToFit } from './json-string-shortening'
import type { QueuePublication } from './structured-agent-session-queued-publication'

/** How a subscriber's rows are read, and so how its pages are sized. */
export function subscriberItemForm(subscriber: { boundedFrames: boolean }): HistoryItemForm {
  return subscriber.boundedFrames ? boundedFrameItem : asStoredHistoryItem
}

/** The latest turn and the activity line are each a few hundred bytes, their ids and text bounded
 *  where they are made. Only a provider id far past any real one could pass these; the frame then
 *  leaves the field out, which a reader takes as a host that did not say. */
export const BOUNDED_FRAME_LATEST_TURN_BYTES = 8 * 1024
export const BOUNDED_FRAME_ACTIVITY_BYTES = 2 * 1024

type HistoryFrame = Exclude<AgentSessionSubscribeEvent, { type: 'end' }>
type BatchFrame = Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
type SideFields = Pick<
  BatchFrame,
  'queuedMessages' | 'queuePause' | 'nextQueuedMessageId' | 'backgroundTasks'
>

function within(value: unknown, maxBytes: number): boolean {
  return value === null || jsonBytes(value) <= maxBytes
}

/** The cursor a reader holds once it has applied `event`, which a side frame must name. */
function cursorAfter(event: HistoryFrame): AgentJournalCursor {
  return event.type === 'batch'
    ? event.batch.cursor
    : (event.page.liveCursor ?? event.page.window.nextCursor)
}

/** `event` without its side lists, and with metadata past its bound left out. */
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
  const frame = {
    ...rest,
    ...(activity !== undefined && within(activity, BOUNDED_FRAME_ACTIVITY_BYTES)
      ? { activity }
      : {})
  }
  if (frame.type === 'batch') {
    const { latestTurn, ...batch } = frame
    return latestTurn === undefined || within(latestTurn, BOUNDED_FRAME_LATEST_TURN_BYTES)
      ? frame
      : batch
  }
  const { latestTurn, ...page } = frame.page
  return latestTurn === undefined || within(latestTurn, BOUNDED_FRAME_LATEST_TURN_BYTES)
    ? frame
    : { ...frame, page }
}

function isEmptyBatch(frame: HistoryFrame): frame is BatchFrame {
  return (
    frame.type === 'batch' &&
    frame.batch.items.length === 0 &&
    frame.batch.removedItemIds.length === 0 &&
    frame.batch.submissions.length === 0
  )
}

/** The newer half of each list in turn until the roster fits, least telling first; `incomplete`
 *  tells a reader that what is listed is not everything. */
function withoutOlderRows(state: AgentSessionBackgroundTaskState): AgentSessionBackgroundTaskState {
  let fitted = state
  for (const list of ['settledTasks', 'children', 'tasks'] as const) {
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

/** One event as a bounded-frame subscriber receives it: the history frame, then an empty batch per
 *  side list it would have carried. An empty history batch is one already, so the first rides it. */
export function boundedFrames(
  event: AgentSessionSubscribeEvent,
  side: BoundedSideLists
): AgentSessionSubscribeEvent[] {
  if (event.type === 'end') {
    return [event]
  }
  const lists: SideFields[] = [
    ...(side.queued === undefined ? [] : [boundedQueuePublication(side.queued)]),
    ...(side.backgroundTasks === undefined
      ? []
      : [{ backgroundTasks: boundedBackgroundTasks(side.backgroundTasks) }])
  ]
  const history = boundedHistoryFrame(event)
  const carrier = (fields: SideFields): BatchFrame => ({
    type: 'batch',
    sessionId: event.sessionId,
    batch: emptyAgentSessionBatch(cursorAfter(event)),
    ...(event.fence === undefined ? {} : { fence: event.fence }),
    ...(event.hostNow === undefined ? {} : { hostNow: event.hostNow }),
    ...fields
  })
  if (lists.length > 0 && isEmptyBatch(history)) {
    const [first, ...others] = lists
    return [{ ...history, ...first }, ...others.map(carrier)]
  }
  return [history, ...lists.map(carrier)]
}
