import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { withJournalText } from '../agent-session-journal/journal-text-rows'
import type { AgentSessionDeltaWindow } from './agent-session-delta-coalescer'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from './structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'

/** Suffix admission and publication occupy one place in the sink's queue. */
export function createStructuredAgentSessionTextAppend(
  queue: StructuredAgentSessionSinkQueue
): NonNullable<StructuredAgentSessionEventSink['tryAppendStreamedItem']> {
  return (identity, body, options) =>
    queue.submit(
      {
        bytes:
          estimateStructuredAgentSessionItemBytes(identity, body) +
          Buffer.byteLength(options.streamText?.suffix ?? '', 'utf8'),
        run: async (bound) => {
          await bound.journal.appendItem(
            identity,
            body,
            structuredAgentSessionJournalAppendOptions(bound.fence, options)
          )
          bound.publish()
        }
      },
      options
    )
}

export function appendStructuredAgentSessionTextWindow(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  window: AgentSessionDeltaWindow,
  options: StructuredAgentSessionItemAppendOptions
): boolean {
  if (sink.tryAppendStreamedItem) {
    return sink.tryAppendStreamedItem(identity, body, {
      ...options,
      streamText: { ...window, field: 0 }
    }).accepted
  }
  const whole = withJournalText(body, 0, window.text())
  const admission = sink.tryAppendItem?.(identity, whole, options)
  if (admission && !admission.accepted) {
    return false
  }
  if (!admission) {
    sink.appendItem(identity, whole, options)
  }
  sink.publish()
  return true
}
