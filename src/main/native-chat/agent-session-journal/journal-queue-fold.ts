// The queue's fold: each card as the chat's own rows say it stands. A card's outcome is decided by
// the row that decides it (its hand-off's dispatch row, an echo proving delivery) and kept from
// then on, so a later rewind that retires the hand-off cannot change it, and replay reads the same.

import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isAgentSessionOptions } from '../../../shared/agent-session-record'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { readStoredRejectionFact } from './journal-dispatch-reducer'
import { rejectedDraftSettlement } from './journal-dispatch-settlement'
import type { JournalQueueRow, JournalQueuedChange } from './journal-queue-events'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { appliedEchoDelivering, draftsDeliveredByEcho } from './queued-message-delivered-echo'
import type { QueuedMessageRow } from './queued-message-table'

export type JournalQueueState = {
  cards: Map<string, QueuedMessageRow>
  /** Moves with every card change, so a reader's memo recomputes only when it must. */
  revision: number
  /** Echoes that already proved a card delivered: each proves one delivery, never a second. */
  pairedEchoes: Set<string>
}

export function createJournalQueueState(): JournalQueueState {
  return { cards: new Map(), revision: 0, pairedEchoes: new Set() }
}

/**
 * What a refusal makes of the dispatched card it handed off: a withdrawal waits again at its own
 * position under the queue's pause; a failure returns the card with its reason, except a command
 * refused in its own turn, which is spent because that turn's row says why and a returned card
 * would hold every card behind it.
 */
export function rejectedCardTransition(
  card: QueuedMessageRow,
  rejected: { reason: string | null; rejection?: UnreadAgentSessionFailureFact },
  commandTurnReported: boolean
): QueuedMessageRow {
  if (rejectedDraftSettlement(rejected).state === 'waiting') {
    return { ...card, state: 'waiting', holdReason: null, consumedAs: null }
  }
  if (card.body.command && commandTurnReported) {
    return { ...card, state: 'withdrawn' }
  }
  return {
    ...card,
    state: 'returned',
    returnedReason: rejected.reason,
    returnedRejection: rejected.rejection ?? null
  }
}

/** The submission's command turn is in the journal: its own row reports the refusal. */
function commandTurnReported(state: JournalReducerState, clientMessageId: string): boolean {
  return state.items.has(
    agentJournalItemKey(structuredAgentSessionCommandTurnIdentity(clientMessageId))
  )
}

/**
 * THE classification of a `queued` change, for the fold, the import and the read of a card not yet
 * imported, so each reads a card exactly as the others do. Its hand-off still in this epoch settles
 * it as that hand-off's answer does; gone, the saved refusal returns it, and with none it is a
 * hand-off nothing can answer: hidden, never resent and never shown as refused. An echo it pairs
 * with joins `pairedEchoes`: the fold's own set, or a reader's copy of it.
 */
export function queuedCardFromChange(
  state: JournalReducerState,
  messageId: string,
  change: JournalQueuedChange,
  pairedEchoes: Set<string>
): QueuedMessageRow {
  const card: QueuedMessageRow = {
    messageId,
    position: change.position,
    body: change.body,
    fingerprint: agentSessionSendBodyFingerprint(state.sessionId, change.body),
    state: 'waiting',
    holdReason: typeof change.holdReason === 'string' ? change.holdReason : null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null,
    queuedAt: readQueuedAt(change.queuedAt),
    ...(isAgentSessionOptions(change.options) ? { options: change.options } : {})
  }
  const attempt =
    typeof change.attempt === 'string' && change.attempt.length > 0 ? change.attempt : null
  const submission = attempt === null ? undefined : state.submissions.get(attempt)
  if (submission) {
    const handedOff: QueuedMessageRow = {
      ...card,
      state: 'dispatched',
      holdReason: null,
      consumedAs: attempt
    }
    return settledHandOff(state, handedOff, submission, pairedEchoes)
  }
  const { returned } = change
  if (typeof returned === 'object' && returned !== null) {
    return {
      ...card,
      state: 'returned',
      holdReason: null,
      consumedAs: attempt,
      returnedReason: typeof returned.reason === 'string' ? returned.reason : null,
      returnedRejection: readStoredRejectionFact(returned.rejection) ?? null
    }
  }
  if (attempt !== null) {
    return { ...card, state: 'dispatched', holdReason: null, consumedAs: attempt }
  }
  return deliveredWaitingCard(state, card, pairedEchoes)
}

/** Before an item or batch applies: each provider echo proving a waiting card's earlier hand-off
 *  was delivered spends that card, so none is sent twice. */
export function foldJournalQueueEcho(state: JournalReducerState, row: JournalRow): void {
  const { cards } = state.queue
  if (cards.size === 0 || (row.kind !== 'item' && row.kind !== 'lifecycle-batch')) {
    return
  }
  for (const delivered of draftsDeliveredByEcho(
    state,
    () => [...cards.values()],
    row,
    state.queue.pairedEchoes
  )) {
    const card = cards.get(delivered)
    if (card) {
      setCard(state, { ...card, state: 'withdrawn', holdReason: null })
    }
  }
}

/** After any row applies: what it does to the cards. */
export function foldJournalQueueRow(state: JournalReducerState, row: JournalRow): void {
  if (row.kind === 'queue') {
    applyQueueRow(state, row)
  } else if (row.kind === 'submission') {
    const card =
      typeof row.queuedMessageId === 'string'
        ? state.queue.cards.get(row.queuedMessageId)
        : undefined
    if (card) {
      setCard(state, {
        ...card,
        state: 'dispatched',
        holdReason: null,
        consumedAs: row.clientMessageId,
        returnedReason: null,
        returnedRejection: null
      })
    }
  } else if (row.kind === 'dispatch') {
    const submission = state.submissions.get(row.clientMessageId)
    const card = cardHandedOffAs(state, submission)
    if (card && submission) {
      setCard(state, settledHandOff(state, card, submission, state.queue.pairedEchoes))
    }
  } else if (row.kind === 'item' || row.kind === 'lifecycle-batch') {
    spendReportedCommandCards(state)
  }
}

function applyQueueRow(state: JournalReducerState, row: JournalQueueRow): void {
  const { change } = row
  if (change.op === 'queued') {
    setCard(state, queuedCardFromChange(state, row.messageId, change, state.queue.pairedEchoes))
    return
  }
  const card = state.queue.cards.get(row.messageId)
  if (!card) {
    return
  }
  if (change.op === 'edited') {
    const fingerprint = agentSessionSendBodyFingerprint(state.sessionId, change.body)
    setCard(state, { ...card, body: change.body, fingerprint })
  } else if (change.op === 'moved') {
    setCard(state, { ...card, position: change.position })
  } else if (change.op === 'held') {
    setCard(state, card.state === 'waiting' ? { ...card, holdReason: change.holdReason } : card)
  } else if (change.op === 'withdrawn') {
    setCard(state, { ...card, state: 'withdrawn', holdReason: null })
  }
}

/** The card handed off as this submission, while that is still its current hand-off: an older
 *  attempt's late answer never moves a newer one. */
function cardHandedOffAs(
  state: JournalReducerState,
  submission: AgentJournalSubmission | undefined
): QueuedMessageRow | undefined {
  const card =
    submission?.queuedMessageId === undefined
      ? undefined
      : state.queue.cards.get(submission.queuedMessageId)
  return card?.state === 'dispatched' && card.consumedAs === submission?.clientMessageId
    ? card
    : undefined
}

function settledHandOff(
  state: JournalReducerState,
  card: QueuedMessageRow,
  submission: AgentJournalSubmission,
  pairedEchoes: Set<string>
): QueuedMessageRow {
  if (submission.dispatchState !== 'rejected') {
    return card
  }
  const reported = commandTurnReported(state, submission.clientMessageId)
  return deliveredWaitingCard(
    state,
    rejectedCardTransition(card, submission, reported),
    pairedEchoes
  )
}

/** A card that waits again is checked against the echoes already applied, so one whose earlier
 *  hand-off reached the agent after all is spent rather than resent. */
function deliveredWaitingCard(
  state: JournalReducerState,
  card: QueuedMessageRow,
  pairedEchoes: Set<string>
): QueuedMessageRow {
  const echo = card.state === 'waiting' ? appliedEchoDelivering(state, card, pairedEchoes) : null
  if (echo === null) {
    return card
  }
  pairedEchoes.add(echo)
  return { ...card, state: 'withdrawn', holdReason: null }
}

/** A returned command card is spent once its own turn's row reports the refusal. */
function spendReportedCommandCards(state: JournalReducerState): void {
  for (const card of state.queue.cards.values()) {
    if (
      card.state === 'returned' &&
      card.body.command &&
      card.consumedAs !== null &&
      commandTurnReported(state, card.consumedAs)
    ) {
      setCard(state, { ...card, state: 'withdrawn' })
    }
  }
}

function setCard(state: JournalReducerState, card: QueuedMessageRow): void {
  if (state.queue.cards.get(card.messageId) !== card) {
    state.queue.cards.set(card.messageId, card)
    state.queue.revision += 1
  }
}

function readQueuedAt(value: unknown): AgentJournalCursor | null {
  return typeof value === 'object' &&
    value !== null &&
    'epoch' in value &&
    typeof value.epoch === 'string' &&
    'sequence' in value &&
    typeof value.sequence === 'number'
    ? { epoch: value.epoch, sequence: value.sequence }
    : null
}
