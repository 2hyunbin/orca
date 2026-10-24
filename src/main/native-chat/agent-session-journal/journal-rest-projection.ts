import { serialize } from 'node:v8'
import type { JournalSelection } from './journal-selection'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { latestStructuredAgentSessionRequest } from '../../../shared/structured-agent-session-latest-request'
import type { JournalReducerState } from './journal-reducer'
import { JournalMutationMap } from './journal-mutation-map'
import { journalSubmissionAt } from './journal-submission-fold'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/structured-agent-session-command-entry'

import { JournalRestWorkProjection } from './journal-rest-work-projection'
export type { JournalStructuralStorage } from './journal-rest-projection-index'

export class JournalRestProjection extends JournalRestWorkProjection {
  fork(selection: JournalSelection = this.selection.fork()): JournalRestProjection {
    const staged = new JournalRestProjection(undefined, undefined, selection)
    staged.requests = new JournalMutationMap(this.requests)
    staged.clears = new JournalMutationMap(this.clears)
    staged.dirty = this.dirty
    staged.revision = this.revision
    staged.latest = this.latest
    staged.floor = this.floor
    staged.floorGeneration = this.floorGeneration
    staged.active = this.active.fork()
    staged.cuts = new JournalMutationMap(this.cuts, (value) => value.fork())
    staged.cutAt = new JournalMutationMap(this.cutAt)
    staged.cutBuckets = new JournalMutationMap(this.cutBuckets)
    staged.predecessors = new JournalMutationMap(this.predecessors)
    staged.submissionWork = new JournalMutationMap(this.submissionWork)
    staged.origins = new JournalMutationMap(this.origins)
    staged.legacy = this.legacy
    return staged
  }

  protected observeOne(state: JournalReducerState, itemId: string): void {
    const item = state.items.get(itemId)
    if (
      !readAgentJournalTurn(item?.body) &&
      item?.body.kind !== 'semantic-work' &&
      !(item?.body.kind === 'message' && item.body.role === 'user') &&
      !isAgentSessionContextClear(item?.body) &&
      !this.clears.has(itemId) &&
      !this.selection.groups.has(`links:${itemId}`) &&
      !this.requests.has(itemId) &&
      !this.active.entries.has(itemId) &&
      !this.cutAt.has(itemId)
    ) {
      return
    }
    this.revision++
    const oldFloor = this.floor
    const wasClear = this.clears.delete(itemId)
    const clear = item && isAgentSessionContextClear(item.body)
    if (clear) {
      this.clears.set(itemId, item.sequence)
    }
    this.selection.order.update(
      'observedClears',
      itemId,
      clear ? { sequence: item.sequence, ordinal: 0 } : undefined
    )
    if (clear) {
      this.floor = Math.max(this.floor, item.sequence)
    } else if (wasClear) {
      this.floor = Math.max(0, this.selection.order.maximum('observedClears')?.sequence ?? 0)
    }
    const turn = readAgentJournalTurn(item?.body)
    const submission =
      item?.body.kind === 'message' && item.body.role === 'user'
        ? journalSubmissionAt(state, itemId)
        : undefined
    let body = item?.body
    const sourceKey =
      body?.kind === 'semantic-work' && body.source.kind === 'submission'
        ? agentJournalSubmissionKey(body.source.clientMessageId)
        : itemId
    const command = turn?.userItemId
      ? state.items.get(state.aliases.get(turn.userItemId) ?? turn.userItemId)
      : undefined
    const requestSourceId = turn?.userItemId
      ? (state.aliases.get(turn.userItemId) ?? turn.userItemId)
      : itemId
    const requestSubmission = turn?.userItemId
      ? journalSubmissionAt(state, requestSourceId)
      : submission
    const request = item
      ? latestStructuredAgentSessionRequest(
          command ? [command, item] : [item],
          submission && (this.floor === 0 || (submission.acceptedSequence ?? 0) > this.floor)
            ? [submission]
            : []
        )
      : null
    const previous = this.requests.get(itemId)
    const previousUser = previous?.anchor
    if (previousUser) {
      this.selection.groups.update(`links:${previousUser}`, itemId, false)
    }
    if (turn?.userItemId) {
      this.selection.groups.update(`links:${requestSourceId}`, itemId, true)
    }
    const independent =
      submission &&
      item &&
      isRootAgentJournalItem(item) &&
      item.turnScope?.kind !== 'turn' &&
      submission.answeredInTurn?.via !== 'steer' &&
      !isStructuredAgentSessionCommandEntry(item.body)
    if (item && (request || independent)) {
      const next = {
        item: requestSubmission
          ? { ...item, sequence: requestSubmission.submittedSequence ?? item.sequence }
          : {
              ...item,
              sequence: previous?.item.sequence ?? item.sequence,
              sequenceIndex: previous?.item.sequenceIndex ?? item.sequenceIndex
            },
        anchor: requestSubmission ? requestSourceId : itemId
      }
      if (!this.predecessors.has(next.anchor)) {
        this.predecessors.set(next.anchor, this.frontier())
      }
      this.requests.set(itemId, next)
      const ordinals = this.selection.storage.map<string, number>('requestOrdinals')
      let ordinal = ordinals.get(itemId)
      if (ordinal === undefined) {
        ordinal = this.selection.nextOrdinal('requests')
        ordinals.set(itemId, ordinal)
      }
      this.selection.order.update('requests', itemId, {
        sequence: next.item.sequence,
        sequenceIndex: next.item.sequenceIndex,
        ordinal
      })
      if (
        !this.latest ||
        this.latest.item.itemId === itemId ||
        compareAgentJournalItems(next.item, this.latest.item) > 0
      ) {
        this.latest = next
      }
    } else {
      this.selection.order.update('requests', itemId, undefined)
      if (previous) {
        this.requests.set(itemId, { ...previous, retired: true })
      }
      if (this.latest?.item.itemId === itemId) {
        this.dirty = true
      }
    }
    if (sourceKey !== itemId) {
      this.submissionWork.set(sourceKey, itemId)
    } else {
      body = state.items.get(this.submissionWork.get(itemId) ?? '')?.body ?? body
    }
    const pendingCut = this.observeWork(state, itemId, sourceKey, item, body, submission, turn)
    if (oldFloor !== this.floor) {
      this.legacy = undefined
      this.dirty = true
      this.floorGeneration++
    }
    const signatures = this.selection.storage.map<string, string>('restDependencies')
    const selected = this.requests.get(itemId)
    const signature = serialize([
      item !== undefined,
      item?.sequence,
      item?.sequenceIndex,
      item?.turnScope,
      item ? isRootAgentJournalItem(item) : false,
      body?.kind === 'semantic-work'
        ? body
        : body?.kind === 'message'
          ? [body.role, isStructuredAgentSessionCommandEntry(body)]
          : null,
      turn?.userItemId,
      submission && [
        submission.dispatchState,
        submission.recovered,
        submission.answeredInTurn,
        submission.submittedAt,
        submission.submittedSequence,
        submission.acceptedSequence
      ],
      selected && [
        selected.anchor,
        selected.retired,
        selected.item.sequence,
        selected.item.sequenceIndex
      ],
      this.selection.groups.has(`turns:${sourceKey}`)
    ]).toString('base64')
    const changed = signatures.get(itemId) !== signature
    signatures.set(itemId, signature)
    this.push({
      kind: 'post',
      itemId,
      before: oldFloor,
      after: this.floor,
      phase: 0,
      gather: 'rechecks',
      token: this.selection.nextOrdinal('floorTask'),
      changed,
      parent: turn?.userItemId ? requestSourceId : undefined
    })
    if (pendingCut) {
      this.push(pendingCut)
    }
  }
}
