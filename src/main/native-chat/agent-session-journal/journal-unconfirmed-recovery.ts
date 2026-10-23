import { queuedChangeOf } from './journal-queue-retention'
import type { JournalQueueChange, JournalQueuedChange } from './journal-queue-events'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { classifyProviderFrame } from '../agent-session-wire/provider-frame-disposition'
import type { JournalReducerState } from './journal-reducer'
import { unsentSendKeptAsCard } from './journal-unsent-send-hold'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'

export type JournalRecoveryWork = {
  allowsRecovery: () => boolean
  owesSend: (submission: AgentJournalSubmission) => boolean
  generationEnded: (submission: AgentJournalSubmission) => boolean
  activeTurnId: () => string | null
  recoveryViewKey: () => string
}

/** Row order, rather than a turn's creation position, proves the end followed handover. */
export function journalRecoveryEndSequence(row: JournalRow): number {
  const bodies =
    row.kind === 'item'
      ? [row.body]
      : row.kind === 'lifecycle-batch'
        ? row.mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation.body] : []))
        : []
  return bodies.some((body) => {
    const turn = readAgentJournalTurn(body)
    const frame = body.kind === 'status' ? body.providerFrame : undefined
    return (
      (turn && turn.state !== 'running' && turn.state !== 'unverifiable') ||
      (frame &&
        classifyProviderFrame(frame.provider, frame.kind, frame.payload) === 'error-surface')
    )
  })
    ? row.seq
    : 0
}

/** A recovery copy exists only until a receipt or a person's queue action resolves it. */
export function unconfirmedRecoveryCards(
  state: JournalReducerState,
  cards: readonly QueuedMessageRow[],
  work: JournalRecoveryWork | null
): QueuedMessageRow[] {
  if (!work || !work.allowsRecovery()) {
    return []
  }
  const resolved = new Set(cards.flatMap((card) => card.recovers ?? []))
  const executionEndedAt =
    work.activeTurnId() === null
      ? Math.max(
          state.recoveryEndSequence,
          state.queuePauseMarks.latestStop?.event.reason === 'user-stop'
            ? state.queuePauseMarks.latestStop.sequence
            : 0
        )
      : 0
  const doubtful = [...state.submissions.values()].filter(
    (send) =>
      (send.dispatchState === 'pending' || send.dispatchState === 'unknown') &&
      !resolved.has(send.clientMessageId) &&
      !work.owesSend(send) &&
      (work.generationEnded(send) ||
        (send.dispatchState === 'unknown' && send.recovered === true) ||
        (send.handedOverAt !== undefined &&
          executionEndedAt >
            (state.items.get(agentJournalSubmissionKey(send.clientMessageId))?.sequence ??
              Infinity)))
  )
  doubtful.sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
  const first = Math.min(0, ...cards.map((card) => card.position)) - doubtful.length
  const words = agentSessionFailureWords(agentSessionFailureFact('unconfirmed'), {
    surface: 'rejection'
  })
  return doubtful.flatMap((send, index) => {
    const body = unsentSendKeptAsCard(
      { ...send, queuedMessageId: undefined },
      state.items.get(agentJournalSubmissionKey(send.clientMessageId))?.body ?? null
    )
    return body
      ? [
          {
            messageId: `recovery:${send.clientMessageId}`,
            recovers: send.clientMessageId,
            position: first + index,
            body,
            fingerprint: agentSessionSendBodyFingerprint(state.sessionId, body),
            state: 'returned' as const,
            holdReason: null,
            returnedReason: words.reason,
            returnedRejection: words.rejection,
            consumedAs: null,
            queuedAt: { epoch: state.epoch, sequence: send.acceptedSequence ?? 0 },
            ...(send.options ? { options: send.options } : {})
          }
        ]
      : []
  })
}

export function adoptUnconfirmedRecovery(
  cards: readonly QueuedMessageRow[],
  messageId: string,
  change?: JournalQueueChange
): JournalQueuedChange | null {
  const card =
    change?.op === 'queued'
      ? undefined
      : cards.find((entry) => entry.messageId === messageId && entry.recovers)
  return card
    ? {
        ...queuedChangeOf(card),
        returned: {
          reason: card.returnedReason,
          ...(card.returnedRejection ? { rejection: card.returnedRejection } : {})
        }
      }
    : null
}
