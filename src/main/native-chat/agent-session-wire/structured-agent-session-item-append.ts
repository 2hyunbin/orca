// Plain item and lifecycle-batch appends. Each body is held to the journal body ceiling as it
// enters the write queue, so no one write outgrows the queue's caps and stalls the chat.

import { journalBodyWithinCeiling } from '../agent-session-journal/journal-body-ceiling'
import type { JournalLifecycleIdentityMutationInput } from '../agent-session-journal/journal-row-builders'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from './structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'

function mutationWithinCeiling(
  mutation: JournalLifecycleIdentityMutationInput
): JournalLifecycleIdentityMutationInput {
  if (mutation.kind !== 'item') {
    return mutation
  }
  const body = journalBodyWithinCeiling(mutation.body)
  return body === mutation.body ? mutation : { ...mutation, body }
}

export function createStructuredAgentSessionItemAppend(queue: StructuredAgentSessionSinkQueue): {
  appendItem: NonNullable<StructuredAgentSessionEventSink['tryAppendItem']>
  appendLifecycleBatch: (
    settlementId: string,
    mutations: readonly JournalLifecycleIdentityMutationInput[],
    options?: StructuredAgentSessionAppendOptions
  ) => StructuredAgentSessionSinkAdmission
} {
  return {
    appendItem: (identity, written, options) => {
      const body = journalBodyWithinCeiling(written)
      return queue.submit(
        {
          bytes: estimateStructuredAgentSessionItemBytes(identity, body),
          run: (bound) =>
            bound.journal.appendItem(
              identity,
              body,
              structuredAgentSessionJournalAppendOptions(bound.fence, options)
            )
        },
        options
      )
    },
    appendLifecycleBatch: (settlementId, written, options = {}) => {
      const mutations = written.map(mutationWithinCeiling)
      return queue.submit(
        {
          bytes: Buffer.byteLength(JSON.stringify({ settlementId, mutations }), 'utf8') + 512,
          run: (bound) =>
            bound.journal.appendLifecycleBatch({
              settlementId,
              mutations,
              // No row-level linkage: each mutation names its own (see the batch row builder).
              fence: bound.fence,
              // The provider's own observation: its child's generation produced every item it
              // creates.
              ownerFence: bound.fence
            })
        },
        { ...options, lifecycle: true }
      )
    }
  }
}
