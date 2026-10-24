// One provider event's journal writes, admitted as a single sink operation.
//
// A producer that keeps state about what it wrote must change that state only for writes the sink
// took; when an event needs several rows, a refusal of the third after the first two were taken
// would leave the producer and the journal disagreeing. A transition is admitted whole or not at
// all. At execution its steps run as one turn in the journal's write queue, each resolved against
// the fold with every earlier write landed (the steps before it included), so what a step writes
// is decided by the journal, not by memory. Admitted whole, executed as a prefix: once a step
// fails, the steps after it never run, the steps before it stay written, and the sink fails.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalStep } from '../agent-session-journal/journal-step-writer'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionSinkAdmission
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'

/** What a transition step reads: rows by key, every row, and the turns they joined. */
export type StructuredAgentSessionTransitionJournal = Pick<
  AgentSessionJournal,
  | 'textSource'
  | 'textSourceByRaw'
  | 'textSources'
  | 'retireText'
  | 'epoch'
  | 'visitItems'
  | 'itemBody'
  | 'item'
  | 'visitItemsWithLinkage'
  | 'canonicalItemId'
>

export type StructuredAgentSessionTransitionStep =
  | {
      kind: 'item'
      /** Bounds what `resolve` may write; a larger write fails the sink. */
      reservedBytes: number
      /** The row and its whole body; null writes nothing. */
      resolve: (journal: StructuredAgentSessionTransitionJournal) => {
        identity: AgentJournalItemIdentity
        body: AgentJournalItemBody
      } | null
      install?: () => void
      release?: () => void
      options: StructuredAgentSessionItemAppendOptions
    }
  | {
      kind: 'settlement'
      /** Unique per settlement: the journal applies one id once. */
      settlementId: string
      recovered?: true
      /** Paces the queue only; the mutations are the journal's to choose. */
      reservedBytes: number
      /** Read at execution; none writes nothing. */
      resolve: (
        journal: StructuredAgentSessionTransitionJournal
      ) => readonly JournalLifecycleMutationInput[]
    }

export type StructuredAgentSessionTransition = {
  steps: readonly StructuredAgentSessionTransitionStep[]
  /** Rides the sink's lifecycle budget: it ends or settles something. */
  lifecycle: boolean
  /** Internal admission only, for a provider's bounded tail after finalization. */
  finalTail?: true
  /** Announce the writes once they land, when any step wrote. */
  publish: boolean
  /** Host-internal delivery after these writes and their parent publication, in queue order. */
  onPublished?: () => void
}

/** The sink members a transition writer uses. */
export type StructuredAgentSessionTransitionSink = {
  /** Queues one event's writes as a single admitted operation. */
  tryAppendTransition?(
    transition: StructuredAgentSessionTransition
  ): StructuredAgentSessionSinkAdmission
  /** The bound journal's rows as they stand now; null until bound. */
  journalItems?(): StructuredAgentSessionTransitionJournal | null
}

export function createStructuredAgentSessionTransitionMembers(
  queue: StructuredAgentSessionSinkQueue,
  hold: (bytes: number) => { install: () => void; release: () => void }
): Required<StructuredAgentSessionTransitionSink> {
  return { tryAppendTransition: transitionAppend(queue, hold), journalItems: queue.journalItems }
}

function transitionAppend(
  queue: StructuredAgentSessionSinkQueue,
  hold: (bytes: number) => { install: () => void; release: () => void }
): (transition: StructuredAgentSessionTransition) => StructuredAgentSessionSinkAdmission {
  return (transition) => {
    const holdCredit = hold(
      transition.steps.reduce(
        (total, step) =>
          total + (step.kind === 'item' && step.options.streamText ? 0 : step.reservedBytes),
        0
      )
    )
    return queue.submit({
      install: () => {
        holdCredit.install()
        for (const step of transition.steps) {
          if (step.kind === 'item') {
            step.install?.()
          }
        }
      },
      release: () => {
        holdCredit.release()
        for (const step of transition.steps) {
          if (step.kind === 'item') {
            step.release?.()
          }
        }
      },
      bytes:
        transition.steps.reduce((total, step) => total + step.reservedBytes, 0) +
        (transition.publish ? 1 : 0),
      lifecycle: transition.lifecycle,
      finalTail: transition.finalTail,
      run: async (bound) => {
        const { journal, fence } = bound
        const wrote = await journal.appendSteps(
          transition.steps.map((step): JournalStep =>
            step.kind === 'item'
              ? {
                  kind: 'item',
                  resolve: () => step.resolve(journal),
                  options: {
                    ...structuredAgentSessionJournalAppendOptions(fence, step.options),
                    reservedBytes: step.reservedBytes
                  }
                }
              : {
                  kind: 'settlement',
                  batch: {
                    settlementId: step.settlementId,
                    fence,
                    ownerFence: fence,
                    recovered: step.recovered,
                    resolve: () => step.resolve(journal)
                  }
                }
          )
        )
        if (transition.publish && wrote.includes(true)) {
          bound.publish()
        }
        transition.onPublished?.()
      }
    })
  }
}
