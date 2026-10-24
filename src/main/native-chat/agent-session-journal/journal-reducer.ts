import { rememberAppliedSettlementId } from './journal-settlement-id-retention'
import type { JournalRestProjection } from './journal-rest-projection'
import { journalItemDeclaresEcho } from './journal-item-echo'
// Live append and replay share this fold. Revisions change content, preserving creation position
// and unspecified producer linkage; queued/rejected submissions use their handoff/settlement positions.

import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { journalHistoryOrigin, type JournalHistoryOrigin } from './journal-history-origin'
import { journalBatchMutationProducer, journalRenderItem } from './journal-render-item'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import { removeJournalItem, statedOrDerivedTurnScope, upsertJournalItem } from './journal-item-fold'
import { journalItemRevisionIsStale } from './journal-item-revision'
import { observeJournalProviderActivity } from './journal-provider-activity'
import { isJournalStopOrResumeRow, type JournalRow } from './journal-row-schema'
import { acceptSubmissionFromProviderItem, applyJournalSubmission } from './journal-submission-fold'
import { applyJournalDispatchRow } from './journal-dispatch-reducer'
import { queuedHandOffOutcome } from './journal-dispatch-settlement'
import { isWriteFailureSubmission } from '../../../shared/structured-agent-session-dispatch-rejection'
import { projectJournalStopNote } from './journal-stop-note-projection'
import { journalItemExecutionFence } from './journal-item-provenance'
import { retireRewoundJournalSubmission } from './journal-rewind-submission-retirement'
import { latestAgentSessionContextClearSequence } from '../../../shared/agent-session-context-clear'
import { foldJournalQueuePauseMark, type JournalQueuePauseMarks } from './queued-message-pause'
import { foldJournalQueueRow, type JournalQueueState } from './journal-queue-fold'

export {
  MAX_JOURNAL_APPLIED_SETTLEMENT_IDS,
  rememberAppliedSettlementId
} from './journal-settlement-id-retention'

export type JournalReducerState = {
  echoCandidates?: (fingerprint: string) => Iterable<AgentJournalSubmission>
  contextClearSequence?: () => number
  submissionItemSource?: (itemId: string) => string | undefined
  rest: JournalRestProjection
  /** Actual SQL pair read/committed in this epoch; undefined is not a persisted value. */
  persistedRest?: readonly [string | null, number | null]
  agent?: string
  sessionId: string
  epoch: string
  lastSequence: number
  lastActivityAt: number
  /** Earliest individually replayable sequence. */
  oldestSequence: number
  highestFence: number
  items: Map<string, AgentJournalRenderItem>
  /** Creation provenance determines whether an item belongs to current execution. */
  itemFences: Map<string, number>
  /** Later runs may explicitly assume execution of reusable child items. */
  itemExecutionOwners: Map<string, number>
  providerActivityAt: Map<number, number>
  /** Retain removed revisions to prevent stale resurrection. */
  tombstones: Map<string, number>
  /** Rewound turns remain ended even after their visible records disappear. */
  removedTurnIds: Set<string>
  submissionVersion: number
  submissions: Map<string, AgentJournalSubmission>
  receipts: Map<string, AgentJournalAcceptanceReceipt>
  /** Alias provider echoes to existing optimistic submissions to prevent duplicate bubbles. */
  aliases: Map<string, string>
  /** Preserve the first declared echo contract through tombstones. */
  itemEchoes: Map<string, unknown>
  appliedSettlementIds: Set<string>
  derivedTurnScope: JournalDerivedTurnScope
  /** Acceptance survives visible-message rewind; zero means none in this epoch. */
  latestAcceptedTurnSequence: number
  queuePauseMarks: JournalQueuePauseMarks
  stoppedHistoryCarried: Map<string, readonly string[]>
  queuedHandOffPlaces: Map<
    string,
    Pick<AgentJournalRenderItem, 'sequence' | 'observedAt' | 'turnScope'>
  >
  /** Historical display corrections, rebuilt by the hand-off fold on replay. */
  normalizedHandOffs: Set<string>
  /** The queued messages, folded from their own rows and their hand-offs (`journal-queue-fold.ts`). */
  queue: JournalQueueState
  historyOrigin: JournalHistoryOrigin | null
}

export { createJournalReducerState } from './journal-reducer-state'

export function applyJournalRow(
  state: JournalReducerState,
  row: JournalRow,
  savedAt = row.ts
): void {
  const revision = state.rest.revision
  const queuedAttempt =
    row.kind === 'queue' && row.change.op === 'queued' && typeof row.change.attempt === 'string'
      ? row.change.attempt
      : undefined
  const beforeQueue = queuedAttempt ? state.submissions.get(queuedAttempt) : undefined
  applyJournalRowBody(state, row, savedAt)
  foldJournalQueueRow(state, row)
  const queueRecovery =
    beforeQueue?.dispatchState === 'rejected' && queuedHandOffOutcome(beforeQueue) === 'inDoubt'
  const ids =
    row.kind === 'item' || row.kind === 'tombstone'
      ? [row.itemId]
      : row.kind === 'lifecycle-batch'
        ? row.mutations.map((mutation) => mutation.itemId)
        : row.kind === 'submission' || row.kind === 'dispatch'
          ? [agentJournalSubmissionKey(row.clientMessageId)]
          : []
  if (queueRecovery && queuedAttempt !== undefined) {
    ids.push(agentJournalSubmissionKey(queuedAttempt))
  }
  for (const id of ids) {
    state.rest.observe(state, state.aliases.get(id) ?? id)
  }
  // Open hygiene changes canonical truth; an actual Stop still has its original event edge.
  const recovered =
    queueRecovery ||
    row.recovered ||
    (row.kind === 'lifecycle-batch' &&
      row.mutations.every((mutation) => mutation.kind === 'item' && mutation.recovered))
  if (recovered) {
    state.rest.revision = revision
  }
  if (row.kind === 'tombstone' && row.stopEvent) {
    state.rest.revision++
  }
}

function applyJournalRowBody(state: JournalReducerState, row: JournalRow, savedAt: number): void {
  state.lastSequence = Math.max(state.lastSequence, row.seq)
  state.highestFence = Math.max(state.highestFence, row.fence)
  if (row.kind === 'epoch') {
    state.agent =
      row.providerHandle.kind === 'opaque' ? row.providerHandle.agent : row.providerHandle.kind
    state.historyOrigin = journalHistoryOrigin(row)
    return
  }
  // Queued cards cannot extend working status or postpone idle sweeps.
  if (row.kind === 'queue') {
    return
  }
  state.lastActivityAt = Math.max(state.lastActivityAt, row.ts)
  if (row.kind === 'item') {
    if (journalItemRevisionIsStale(state, row.itemId, row.revision)) {
      return
    }
    if (!state.itemEchoes.has(row.itemId) && Object.hasOwn(row, 'echoOf')) {
      state.itemEchoes.set(row.itemId, row.echoOf)
    }
    const itemId = resolveJournalItemId(state, row.itemId, row.body)
    if (!state.itemEchoes.has(row.itemId)) {
      acceptSubmissionFromProviderItem(state, row.itemId, itemId, row)
    }
    upsertJournalItem(
      state,
      itemId,
      row.revision,
      journalRenderItem(itemId, row.revision, row.body, row, statedOrDerivedTurnScope(state, row)),
      { fence: row.fence, ownerFence: row.ownerFence, executionOwner: row.executionOwner }
    )
    const fence = journalItemExecutionFence(state, itemId) ?? row.fence
    observeJournalProviderActivity(state, row, row.itemId, row.body, savedAt, fence)
    return
  }
  if (isJournalStopOrResumeRow(row)) {
    foldJournalQueuePauseMark(state.queuePauseMarks, row)
    return
  }
  if (row.kind === 'tombstone') {
    removeJournalItem(state, resolveItemId(state, row.itemId), row.revision)
    if (row.retireSubmission === true) {
      retireRewoundJournalSubmission(state, row.itemId)
    }
    return
  }
  if (row.kind === 'lifecycle-batch') {
    if (state.appliedSettlementIds.has(row.settlementId)) {
      return
    }
    for (const [sequenceIndex, mutation] of row.mutations.entries()) {
      if (mutation.kind === 'item') {
        if (journalItemRevisionIsStale(state, mutation.itemId, mutation.revision)) {
          continue
        }
        if (!state.itemEchoes.has(mutation.itemId) && Object.hasOwn(mutation, 'echoOf')) {
          state.itemEchoes.set(mutation.itemId, mutation.echoOf)
        }
        const { revision, body } = mutation
        const itemId = resolveJournalItemId(state, mutation.itemId, body)
        if (!state.itemEchoes.has(mutation.itemId)) {
          acceptSubmissionFromProviderItem(state, mutation.itemId, itemId, row)
        }
        const producer = journalBatchMutationProducer(row, mutation)
        const scope = statedOrDerivedTurnScope(state, mutation)
        const item = journalRenderItem(
          itemId,
          revision,
          body,
          {
            ...row,
            ...(mutation.recovered
              ? { recovered: mutation.recovered, recoveredAt: mutation.recoveredAt }
              : {})
          },
          scope,
          producer,
          sequenceIndex
        )
        item.observedAt = mutation.observedAt ?? row.ts
        upsertJournalItem(state, itemId, revision, item, {
          fence: row.fence,
          ownerFence: mutation.ownerFence
        })
        const fence = journalItemExecutionFence(state, itemId) ?? row.fence
        observeJournalProviderActivity(state, row, mutation.itemId, body, savedAt, fence)
      } else {
        removeJournalItem(state, resolveItemId(state, mutation.itemId), mutation.revision)
      }
    }
    rememberAppliedSettlementId(state, row.settlementId)
    return
  }
  if (row.kind === 'submission') {
    applyJournalSubmission(state, row)
    return
  }
  applyJournalDispatchRow(state, row)
}

export function resolveJournalItemId(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string {
  const aliased = state.aliases.get(itemId)
  if (aliased) {
    return aliased
  }
  const submissionId = journalEchoClaimant(state, itemId, body)
  if (!submissionId) {
    return itemId
  }
  state.aliases.set(itemId, submissionId)
  return submissionId
}

export function isProviderUserMessageEcho(
  itemId: string,
  body: AgentJournalRenderItem['body']
): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return (
    body.kind === 'message' &&
    body.role === 'user' &&
    identity !== null &&
    identity.provider !== 'orca'
  )
}

/** Find an echo's eligible submission without claiming it. */
export function journalEchoClaimant(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string | null {
  if (
    !body ||
    journalItemDeclaresEcho(state.itemEchoes, itemId) ||
    !isProviderUserMessageEcho(itemId, body)
  ) {
    return null
  }
  const fingerprint = agentSessionSendBodyFingerprint(state.sessionId, body)
  const contextSequence =
    state.contextClearSequence?.() ?? latestAgentSessionContextClearSequence(state.items.values())
  // Exact payload plus queue order preserves repeated identical sends one-for-one.
  // A submission an echo may not claim is one that says the message never reached
  // the provider, so an item resembling it is somebody else's. That is `rejected`
  // now — and, in journals written before this state moved, an `unknown` carrying
  // the transport marker. Replaying an older journal must not let such a row alias
  // the echo of a later, genuinely delivered resend of the same text.
  let submission: AgentJournalSubmission | undefined
  for (const candidate of state.echoCandidates?.(fingerprint) ?? state.submissions.values()) {
    if (
      (contextSequence === 0 || (candidate.acceptedSequence ?? 0) > contextSequence) &&
      candidate.dispatchState !== 'rejected' &&
      !isWriteFailureSubmission(candidate) &&
      candidate.payloadFingerprint === fingerprint &&
      state.items.get(agentJournalSubmissionKey(candidate.clientMessageId))?.revision === 0 &&
      (!submission || candidate.submittedAt < submission.submittedAt)
    ) {
      submission = candidate
    }
  }
  return submission ? agentJournalSubmissionKey(submission.clientMessageId) : null
}

function resolveItemId(state: JournalReducerState, itemId: string): string {
  return state.aliases.get(itemId) ?? itemId
}

export function renderJournalState(state: JournalReducerState): AgentJournalSnapshot {
  // Map insertion order changes on recreation; journal position alone orders the timeline.
  const items = [...state.items.values()]
    .map((item) => projectJournalStopNote(item, state.items))
    .sort(compareAgentJournalItems)
  return {
    sessionId: state.sessionId,
    cursor: { epoch: state.epoch, sequence: state.lastSequence },
    items,
    submissions: [...state.submissions.values()].sort((a, b) => a.submittedAt - b.submittedAt)
  }
}
