import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalSubmission,
  AgentJournalStatusItem
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { readCodexErrorWillRetry } from '../../codex/codex-structured-thread-facts'
import { applyJournalRow } from './journal-reducer'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import type {
  JournalRow,
  JournalSubmissionRow,
  JournalDispatchRow,
  JournalItemRow,
  JournalTombstoneRow
} from './journal-row-schema'
import type { JournalRecoveryWork } from './journal-unconfirmed-recovery'

export function createJournalInputObligations() {
  return {
    sources: new Map<string, JournalSubmissionRow>(),
    handovers: new Map<string, JournalDispatchRow>(),
    outcomes: new Map<string, JournalDispatchRow>(),
    candidates: new Map<string, AgentJournalSubmission>(),
    ends: new Map<string, JournalItemRow | JournalTombstoneRow>(),
    ended: new Map<string, JournalItemRow | JournalTombstoneRow>(),
    revision: 0
  }
}

/** Reconstructed source ownership is independent of the replaceable render timeline. */
export function foldJournalInputObligations(
  state: JournalReducerState,
  row: JournalRow,
  dispatchApplies = true
): void {
  const input = state.inputs
  if (row.kind === 'submission') {
    input.sources.set(row.clientMessageId, row)
  }
  if (row.kind === 'dispatch' && !dispatchApplies) {
    return
  }
  if (row.kind === 'dispatch') {
    const target = row.state === 'pending' ? input.handovers : input.outcomes
    const source = input.sources.get(row.clientMessageId)
    const scope = source && state.derivedTurnScope.scopeFor(source.body)
    target.set(
      row.clientMessageId,
      row.state === 'pending' &&
        scope?.kind === 'turn' &&
        readAgentJournalTurn(state.items.get(scope.turnItemId)?.body)?.state === 'running' &&
        row.turnScope?.kind !== 'turn'
        ? { ...row, turnScope: scope }
        : row
    )
  }
  if (row.kind === 'submission' || row.kind === 'dispatch') {
    const send = state.submissions.get(row.clientMessageId)
    if (send && (send.dispatchState === 'pending' || send.dispatchState === 'unknown')) {
      input.candidates.set(row.clientMessageId, send)
    } else {
      input.candidates.delete(row.clientMessageId)
    }
    input.revision++
  }
  const items =
    row.kind === 'item'
      ? [row]
      : row.kind === 'lifecycle-batch'
        ? row.mutations.flatMap((m) =>
            m.kind === 'item' ? [{ ...row, ...m, kind: 'item' as const }] : []
          )
        : []
  for (const item of items) {
    if (item.agentId || state.items.get(item.itemId)?.body !== item.body) {
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    const frame = item.body.kind === 'status' ? item.body.providerFrame : undefined
    if (turn) {
      input.ends.set(item.itemId, item)
    }
    if (
      (turn && turn.state !== 'running' && turn.state !== 'unverifiable') ||
      providerAttemptEnded(frame)
    ) {
      input.ends.set(item.itemId, item)
      const candidates = [...input.candidates.values()].filter(
        (send) =>
          (input.handovers.get(send.clientMessageId)?.fence ??
            input.sources.get(send.clientMessageId)?.fence ??
            send.fence) === (item.executionOwner ?? item.ownerFence ?? item.fence)
      )
      const latest = candidates.reduce(
        (last, send) =>
          Math.max(
            last,
            input.handovers.get(send.clientMessageId)?.seq ?? send.submittedSequence ?? 0
          ),
        0
      )
      for (const send of candidates) {
        const handover = input.handovers.get(send.clientMessageId)
        const source = input.sources.get(send.clientMessageId)
        const after =
          handover?.seq ?? (send.handoverRecorded ? Infinity : (source?.seq ?? Infinity))
        const scope = handover?.turnScope ?? source?.turnScope
        const target = item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : item.itemId
        const user = turn?.userItemId
        const matches =
          scope?.kind === 'turn'
            ? scope.turnItemId === target
            : user
              ? user === agentJournalSubmissionKey(send.clientMessageId)
              : after === latest
        if (matches && item.seq > after && !input.ended.has(send.clientMessageId)) {
          input.ended.set(send.clientMessageId, item)
          input.revision++
        }
      }
    }
  }
  if (row.kind === 'tombstone' && row.stopEvent) {
    const previous = input.ends.get(row.itemId)
    if (
      previous?.kind === 'tombstone' &&
      JSON.stringify(previous.stopEvent) === JSON.stringify(row.stopEvent)
    ) {
      return
    }
    input.ends.set(row.itemId, row)
    for (const send of input.candidates.values()) {
      const handover = input.handovers.get(send.clientMessageId)
      const scope = handover?.turnScope
      const end = scope?.kind === 'turn' ? input.ends.get(scope.turnItemId) : undefined
      const turn = readAgentJournalTurn(
        end?.kind === 'item'
          ? end.body
          : scope?.kind === 'turn'
            ? state.items.get(scope.turnItemId)?.body
            : undefined
      )
      if (
        handover &&
        handover.fence === row.fence &&
        row.seq > handover.seq &&
        row.stopEvent.reason === 'user-stop' &&
        (!row.stopEvent.turnId || turn?.turnId === row.stopEvent.turnId) &&
        !input.ended.has(send.clientMessageId)
      ) {
        input.ended.set(send.clientMessageId, row)
      }
    }
    input.revision++
  }
}

function providerAttemptEnded(frame: AgentJournalStatusItem['providerFrame']): boolean {
  if (
    frame?.provider !== 'codex' ||
    frame.kind !== 'notification:error' ||
    frame.payload.truncated
  ) {
    return false
  }
  try {
    return !readCodexErrorWillRetry(JSON.parse(frame.payload.head))
  } catch {
    return false
  }
}

/** End of this execution attempt is an observation, never evidence of delivery. */
export function journalInputAttemptEnded(
  state: JournalReducerState,
  send: AgentJournalSubmission,
  work: JournalRecoveryWork | null
): boolean {
  const original = {
    ...send,
    fence:
      state.inputs.handovers.get(send.clientMessageId)?.fence ??
      state.inputs.sources.get(send.clientMessageId)?.fence ??
      send.fence
  }
  if (!work?.allowsRecovery() || work.owesSend(original)) {
    return false
  }
  if (work.generationEnded(original) || (send.dispatchState === 'unknown' && send.recovered)) {
    return true
  }
  return state.inputs.ended.has(send.clientMessageId)
}

/** Restate original causal rows, including resolutions, without manufacturing a handover. */
export function retainedJournalInputRows(previous: JournalReducerState): JournalRow[] {
  const input = previous.inputs
  const retained = new Set(
    [...input.sources.keys()].filter(
      (id) =>
        previous.submissions.get(id)?.dispatchState !== 'accepted' ||
        input.handovers.get(id)?.carries?.length
    )
  )
  const rows: JournalRow[] = [
    ...[...input.sources.values(), ...input.handovers.values(), ...input.outcomes.values()].filter(
      (row) => retained.has(row.clientMessageId)
    ),
    ...new Set([
      ...input.ended.values(),
      ...[...input.handovers.values()].flatMap((row) => {
        const end =
          row.turnScope?.kind === 'turn' ? input.ends.get(row.turnScope.turnItemId) : undefined
        return end && retained.has(row.clientMessageId) ? [end] : []
      })
    ])
  ]
  return rows.sort((a, b) => a.seq - b.seq)
}

export function restateJournalInputs(
  previous: JournalReducerState | undefined,
  state: JournalReducerState,
  rows: JournalRow[],
  visible: ReadonlySet<string>
): void {
  if (!previous) {
    return
  }
  for (const original of retainedJournalInputRows(previous)) {
    const row = { ...original, epoch: state.epoch, seq: state.lastSequence + 1 }
    applyJournalRow(state, row)
    rows.push(row)
  }
  for (const item of state.items.values()) {
    const identity = parseAgentJournalItemKey(item.itemId)
    const send =
      identity?.provider === 'orca'
        ? state.inputs.candidates.get(identity.clientMessageId)
        : undefined
    if (visible.has(item.itemId) || (send && isQueuedAgentJournalSubmission(send))) {
      continue
    }
    const row: JournalRow = {
      kind: 'tombstone',
      itemId: item.itemId,
      revision: item.revision + 1,
      v: 1,
      epoch: state.epoch,
      seq: state.lastSequence + 1,
      fence: state.highestFence,
      ts: item.observedAt
    }
    applyJournalRow(state, row)
    rows.push(row)
  }
}
