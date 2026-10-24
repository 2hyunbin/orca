import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  applyJournalLifecycleMutation,
  applyJournalRowBody,
  rememberAppliedSettlementId,
  type JournalReducerState
} from './journal-reducer'
import { foldJournalQueueRow, spendOneReportedCommandCard } from './journal-queue-fold'
import { queuedHandOffOutcome } from './journal-dispatch-settlement'
import { removeJournalItem } from './journal-item-fold'
import {
  retireOneRewoundAlias,
  retireRewoundJournalSubmission
} from './journal-rewind-submission-retirement'
import { isJournalStopOrResumeRow, type JournalRow } from './journal-row-schema'

export type JournalPendingRow = {
  sequence: number
  sourceHash: string
  phase: 'body' | 'source' | 'aliases' | 'settlement' | 'queue' | 'observe' | 'finish'
  offset: number
  duplicate: boolean
  revision: number
  queueRecovery: boolean
  recovered: boolean
  carried?: string | null
  observing?: true
  next?: 'body' | 'queue' | 'observe'
}

function rowItemCount(row: JournalRow, recovery: boolean): number {
  const count =
    row.kind === 'lifecycle-batch'
      ? row.mutations.length
      : row.kind === 'item' ||
          row.kind === 'tombstone' ||
          row.kind === 'submission' ||
          row.kind === 'dispatch'
        ? 1
        : 0
  return count + (recovery ? 1 : 0)
}

function observedId(row: JournalRow, offset: number): string {
  if (row.kind === 'lifecycle-batch') {
    return row.mutations[offset]!.itemId
  }
  if (row.kind === 'item' || row.kind === 'tombstone') {
    return row.itemId
  }
  if (row.kind === 'submission' || row.kind === 'dispatch') {
    return agentJournalSubmissionKey(row.clientMessageId)
  }
  if (
    row.kind === 'queue' &&
    row.change.op === 'queued' &&
    typeof row.change.attempt === 'string'
  ) {
    return agentJournalSubmissionKey(row.change.attempt)
  }
  throw new Error('invalid pending journal observation')
}

/** A step completes one source mutation, group member, dependency frame, or row boundary. */
export function stepStructuralJournalRow(
  state: JournalReducerState,
  row: JournalRow,
  savedAt: number,
  sourceHash: string,
  pending?: JournalPendingRow
): JournalPendingRow | undefined {
  let work = pending
  if (!work) {
    const attempt =
      row.kind === 'queue' && row.change.op === 'queued' && typeof row.change.attempt === 'string'
        ? state.submissions.get(row.change.attempt)
        : undefined
    work = {
      sequence: row.seq,
      sourceHash,
      phase: 'body',
      offset: 0,
      revision: state.rest.revision,
      duplicate: row.kind === 'lifecycle-batch' && state.appliedSettlementIds.has(row.settlementId),
      queueRecovery:
        attempt?.dispatchState === 'rejected' && queuedHandOffOutcome(attempt) === 'inDoubt',
      recovered: row.kind === 'lifecycle-batch' ? true : !!row.recovered
    }
    state.lastSequence = Math.max(state.lastSequence, row.seq)
    state.highestFence = Math.max(state.highestFence, row.fence)
    if (row.kind !== 'epoch' && row.kind !== 'queue') {
      state.lastActivityAt = Math.max(state.lastActivityAt, row.ts)
    }
    return work
  }
  if (work.sequence !== row.seq || work.sourceHash !== sourceHash) {
    throw new Error('pending journal source changed')
  }
  if (work.phase === 'body') {
    if (row.kind === 'lifecycle-batch') {
      const mutation = row.mutations[work.offset]
      if (!mutation) {
        return { ...work, phase: 'settlement', offset: 0 }
      }
      if (!work.duplicate) {
        applyJournalLifecycleMutation(state, row, work.offset, savedAt)
      }
      return {
        ...work,
        phase: 'source',
        next: 'body',
        offset: work.offset + 1,
        recovered: work.recovered && mutation.kind === 'item' && !!mutation.recovered
      }
    }
    if (row.kind === 'tombstone' && !isJournalStopOrResumeRow(row)) {
      removeJournalItem(state, state.aliases.get(row.itemId) ?? row.itemId, row.revision)
      if (row.retireSubmission === true) {
        retireRewoundJournalSubmission(state, row.itemId, false)
        return { ...work, phase: 'aliases' }
      }
    } else {
      if (row.kind === 'dispatch' && row.state === 'pending' && work.carried === undefined) {
        const carries = Array.isArray(row.carries) ? row.carries : []
        const value = carries[work.offset]
        if (work.offset < carries.length) {
          return {
            ...work,
            offset: work.offset + 1,
            carried: typeof value === 'string' && value.length > 0 ? value : undefined
          }
        }
        return { ...work, carried: null }
      }
      applyJournalRowBody(
        state,
        row,
        savedAt,
        row.kind === 'dispatch' ? (work.carried ? [work.carried] : []) : undefined
      )
    }
    return { ...work, phase: 'source', next: 'queue', offset: 0 }
  }
  if (work.phase === 'aliases') {
    if (row.kind === 'tombstone' && retireOneRewoundAlias(state, row.itemId)) {
      return work
    }
    return { ...work, phase: 'source', next: 'queue', offset: 0 }
  }
  if (work.phase === 'source') {
    return state.selection.refreshStep(state) ? work : { ...work, phase: work.next ?? 'queue' }
  }
  if (work.phase === 'settlement') {
    if (row.kind === 'lifecycle-batch' && !work.duplicate) {
      rememberAppliedSettlementId(state, row.settlementId)
    }
    return { ...work, phase: 'queue' }
  }
  if (work.phase === 'queue') {
    if (row.kind === 'item' || row.kind === 'lifecycle-batch') {
      if (spendOneReportedCommandCard(state)) {
        return work
      }
    } else {
      foldJournalQueueRow(state, row)
      return { ...work, phase: 'source', next: 'observe', offset: 0 }
    }
    return { ...work, phase: 'observe', offset: 0 }
  }
  if (work.phase === 'observe') {
    if (work.observing) {
      return state.rest.observationStep(state)
        ? work
        : { ...work, observing: undefined, offset: work.offset + 1 }
    }
    if (work.offset === rowItemCount(row, work.queueRecovery)) {
      const affected = state.selection.groups.next('aliasRestDirty')?.key
      if (affected !== undefined) {
        state.selection.groups.update('aliasRestDirty', affected, false)
        state.rest.beginObservation(affected)
        return { ...work, observing: true, offset: work.offset - 1 }
      }
      return { ...work, phase: 'finish' }
    }
    const id = observedId(row, work.offset)
    state.rest.beginObservation(state.aliases.get(id) ?? id)
    return { ...work, observing: true }
  }
  if (work.queueRecovery || row.recovered || work.recovered) {
    state.rest.revision = work.revision
  }
  if (row.kind === 'tombstone' && row.stopEvent) {
    state.rest.revision++
  }
  state.queuePauseMarks = { latestStop: null, resumedSequence: 0, reopenedSequence: 0 }
  state.historyOrigin = null
  return undefined
}
