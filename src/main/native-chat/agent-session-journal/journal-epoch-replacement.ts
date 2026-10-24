import {
  journalItemEchoFields,
  journalItemEchoRestatement,
  type JournalItemEcho
} from './journal-item-echo'

import { journalSubmissionAt } from './journal-submission-fold'
import { sameJournalConversation } from './journal-history-origin'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'

import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import {
  buildJournalItemRow,
  buildJournalSubmissionRow,
  journalRowBase
} from './journal-row-builders'
import { buildJournalQueueRow } from './journal-queue-events'
import type { JournalQueueRestatement } from './journal-queued-messages'
import {
  buildJournalQueueReopenRow,
  buildJournalQueueClearRow,
  buildJournalQueueResumeRow,
  buildJournalStopEventRow
} from './journal-stop-and-resume-rows'
import type { JournalQueuePauseRestatement } from './queued-message-pause'
import {
  deleteJournalEpochRows,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalSessionEpoch,
  writeJournalRestFact
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { assertJournalFence } from './journal-write-guards'
import type { JournalOperationReceipt } from './journal-row-writer'

export type JournalReplacementItem = AgentJournalProducerLinkage & {
  echoOf?: JournalItemEcho['echoOf']
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt?: number
  recovered?: true
  recoveredAt?: number
  /** Absent for history rebuilt from a source that never stated one: derived from position, as
   *  a legacy row's is, and then written down. */
  turnScope?: AgentJournalTurnScope
  /** Preserve original execution provenance; history replacement is not new work. */
  ownerFence: number
  executionOwner?: number
}

export function replaceJournalEpoch(input: {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
  receipt?: (cursor: AgentJournalCursor) => JournalOperationReceipt
  previous?: JournalReducerState
  /** Preserve Stop/Resume state so rewinds cannot release held cards or resurrect lifted pauses. */
  queuePause: JournalQueuePauseRestatement
  /** Restate cards before carried submissions relink their handoffs. */
  queue: JournalQueueRestatement
  now: () => number
  mintEpoch: () => string
  /** Adopt committed state before fallible follow-up work. */
  onPublished: (loaded: JournalLoad) => void
}): void {
  const epoch = input.mintEpoch()
  const state = createJournalReducerState(input.identity.sessionId, epoch)
  const providerHandle = agentSessionJournalProviderHandle(input.identity)
  const previousOrigin = input.previous?.historyOrigin
  const restate =
    input.reason !== 'legacy_import' &&
    input.reason !== 'session_created' &&
    previousOrigin &&
    sameJournalConversation(previousOrigin.providerHandle, providerHandle)
  const epochRow: JournalRow = {
    kind: 'epoch',
    reason:
      input.reason === 'legacy_import' && input.items.length === 0
        ? 'session_created'
        : input.reason,
    providerHandle,
    ...(restate ? { historyOrigin: previousOrigin.raw } : {}),
    ...journalRowBase(epoch, 1, input.fence, input.now())
  }
  const rows: JournalRow[] = [epochRow]
  applyJournalRow(state, epochRow)
  const retainedSources = new Map(
    input.items.flatMap((item) => {
      const key = agentJournalItemKey(item.identity)
      const previous = input.previous
      const source = previous && journalSubmissionAt(previous, previous.aliases.get(key) ?? key)
      return source && !isQueuedAgentJournalSubmission(source)
        ? [[source.clientMessageId, source] as const]
        : []
    })
  )
  const sources = [...retainedSources.values()].sort(
    (a, b) => (a.submittedSequence ?? 0) - (b.submittedSequence ?? 0)
  )
  let sourceIndex = 0
  for (const item of input.items) {
    const key = agentJournalItemKey(item.identity)
    const previous = input.previous
    const position = previous?.items.get(previous.aliases.get(key) ?? key)?.sequence ?? Infinity
    while (sources[sourceIndex] && (sources[sourceIndex].submittedSequence ?? 0) <= position) {
      const submission = sources[sourceIndex++]
      const sourceItem = previous?.items.get(agentJournalSubmissionKey(submission.clientMessageId))
      const source = sourceItem?.body
      if (source?.kind !== 'message') {
        throw new Error('retained submission source missing')
      }
      const accepted = buildJournalSubmissionRow({
        ...submission,
        state,
        body: source,
        providerHandle,
        seq: state.lastSequence + 1,
        fence: submission.fence,
        ts: submission.submittedAt
      })
      applyJournalRow(state, accepted)
      rows.push(accepted)
      if (submission.handedOverAt !== undefined) {
        const pending: JournalRow = {
          kind: 'dispatch',
          clientMessageId: submission.clientMessageId,
          state: 'pending',
          providerItemId: null,
          reason: null,
          turnScope: sourceItem?.turnScope,
          ...journalRowBase(
            epoch,
            state.lastSequence + 1,
            submission.fence,
            submission.handedOverAt
          )
        }
        applyJournalRow(state, pending)
        rows.push(pending)
      }
      if (submission.dispatchState !== 'pending') {
        const dispatch: JournalRow = {
          kind: 'dispatch',
          clientMessageId: submission.clientMessageId,
          state: submission.dispatchState,
          providerItemId: submission.providerItemId,
          reason: submission.reason,
          recovered: submission.recovered,
          rejection: submission.rejection,
          keptAsQueuedMessageId: submission.keptAsQueuedMessageId,
          answeredInTurn: submission.answeredInTurn,
          ...journalRowBase(
            epoch,
            state.lastSequence + 1,
            submission.fence,
            submission.resolvedAt ?? submission.submittedAt
          )
        }
        applyJournalRow(state, dispatch)
        rows.push(dispatch)
      }
    }
    const row = buildJournalItemRow({
      state,
      identity: item.identity,
      body: item.body,
      recovered: item.recovered,
      recoveredAt: item.recoveredAt,
      ...journalItemEchoFields(item),
      ...(input.previous && input.reason !== 'legacy_import' && input.reason !== 'session_created'
        ? journalItemEchoRestatement(
            input.previous.itemEchoes,
            input.previous.aliases.get(agentJournalItemKey(item.identity)) ??
              agentJournalItemKey(item.identity)
          )
        : {}),
      seq: state.lastSequence + 1,
      fence: input.fence,
      ownerFence: item.ownerFence,
      executionOwner: item.executionOwner,
      ts: item.observedAt ?? input.now(),
      linkage: item,
      turnScope: item.turnScope ?? state.derivedTurnScope.scopeFor(item.body)
    })
    assertJournalFence(row.fence, state.highestFence)
    applyJournalRow(state, row)
    rows.push(row)
  }
  for (const { messageId, change } of input.queue.cards) {
    if (change) {
      const row = buildJournalQueueRow(
        state,
        messageId,
        change,
        state.lastSequence + 1,
        input.now()
      )
      applyJournalRow(state, row)
      rows.push(row)
    }
  }
  // Accepted-but-unhanded messages must survive provider history replacement.
  const queued = [...(input.previous?.submissions.values() ?? [])]
    .filter(isQueuedAgentJournalSubmission)
    .sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
  for (const submission of queued) {
    const body = input.previous?.items.get(
      agentJournalSubmissionKey(submission.clientMessageId)
    )?.body
    if (body?.kind !== 'message') {
      throw new Error('journal_queued_submission_body_missing')
    }
    const row = buildJournalSubmissionRow({
      ...submission,
      state,
      body,
      providerHandle: agentSessionJournalProviderHandle(input.identity),
      seq: state.lastSequence + 1,
      fence: input.fence,
      ts: submission.submittedAt
    })
    applyJournalRow(state, row)
    rows.push(row)
  }
  const { lifted, liveStop, reopened } = input.queuePause
  const place = () => ({ state, seq: state.lastSequence + 1, fence: input.fence, ts: input.now() })
  if (lifted) {
    const row = buildJournalQueueResumeRow(place())
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (liveStop) {
    const row = buildJournalStopEventRow({ ...place(), event: liveStop })
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (reopened) {
    const row = buildJournalQueueReopenRow(place())
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (input.queuePause.cleared) {
    const row = buildJournalQueueClearRow({ ...place(), clear: input.queuePause.cleared })
    applyJournalRow(state, row)
    rows.push(row)
  }

  const { sessionId } = input.identity
  const receipt = input.receipt?.({ epoch, sequence: state.lastSequence })
  input.database.transaction((db) => {
    const retired = readJournalSessionEpoch(db, sessionId)
    if (retired !== null) {
      deleteJournalEpochRows(db, sessionId, retired)
    }
    // Before the rows, which keep the new epoch's open turn on its pointer.
    publishJournalSessionEpoch(db, input.identity, epoch)
    for (const row of rows) {
      insertJournalRow(db, sessionId, row)
    }
    input.queue.receipt.write(db)
    writeJournalRestFact(db, sessionId, state.rest.fact())
    receipt?.write(db)
  })
  input.queue.receipt.committed()

  // Adopt the committed epoch immediately; later failures must not leave writers targeting deleted rows.
  state.oldestSequence = 1
  const fact = state.rest.fact()
  state.persistedRest = [fact?.itemId ?? null, fact?.since ?? 0]
  input.onPublished({ state, newer: null, damage: null })
  receipt?.committed()
}
