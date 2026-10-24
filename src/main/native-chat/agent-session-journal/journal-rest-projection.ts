import { isDeepStrictEqual } from 'node:util'
import { semanticWorkRecordId } from '../../../shared/agent-session-semantic-work'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { latestStructuredAgentSessionRequest } from '../../../shared/structured-agent-session-latest-request'
import type { JournalReducerState } from './journal-reducer'
import { JournalMutationMap } from './journal-mutation-map'
import { journalSubmissionAt } from './journal-submission-fold'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/structured-agent-session-command-entry'

import { JournalRestProjectionIndex } from './journal-rest-projection-index'
export type { JournalStructuralStorage } from './journal-rest-projection-index'

export class JournalRestProjection extends JournalRestProjectionIndex {
  fork(): JournalRestProjection {
    const staged = new JournalRestProjection()
    staged.requests = new JournalMutationMap(this.requests)
    staged.clears = new JournalMutationMap(this.clears)
    staged.users = new JournalMutationMap(this.users, (value) => new Set(value))
    staged.dirty = this.dirty
    staged.revision = this.revision
    staged.latest = this.latest
    staged.floor = this.floor
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

  observe(state: JournalReducerState, itemId: string, visiting?: Set<string>): void {
    if (!visiting) {
      visiting = this.storage?.set('visiting') ?? new Set<string>()
      visiting.clear()
    }
    if (visiting.has(itemId)) {
      return
    }
    visiting.add(itemId)
    const item = state.items.get(itemId)
    if (
      !readAgentJournalTurn(item?.body) &&
      item?.body.kind !== 'semantic-work' &&
      !(item?.body.kind === 'message' && item.body.role === 'user') &&
      !isAgentSessionContextClear(item?.body) &&
      !this.clears.has(itemId) &&
      this.linked(itemId).size === 0 &&
      !this.requests.has(itemId) &&
      !this.active.entries.has(itemId) &&
      !this.cutAt.has(itemId)
    ) {
      return
    }
    this.revision++
    const oldFloor = this.floor
    const wasClear = this.clears.delete(itemId)
    if (item && isAgentSessionContextClear(item.body)) {
      this.clears.set(itemId, item.sequence)
      this.floor = Math.max(this.floor, item.sequence)
    } else if (wasClear) {
      this.floor = 0
      for (const sequence of this.clears.values()) {
        this.floor = Math.max(this.floor, sequence)
      }
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
      this.linked(previousUser).delete(itemId)
    }
    if (turn?.userItemId) {
      const linked = this.linked(requestSourceId, true)
      linked.add(itemId)
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
      if (
        !this.latest ||
        this.latest.item.itemId === itemId ||
        compareAgentJournalItems(next.item, this.latest.item) > 0
      ) {
        this.latest = next
      }
    } else {
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
    if (
      body?.kind === 'semantic-work' ||
      submission ||
      (turn && isRootAgentJournalItem(item)) ||
      this.active.entries.has(itemId) ||
      this.cutAt.has(itemId)
    ) {
      const originalCut = this.cutAt.get(sourceKey)
      const old = this.cutBuckets.get(sourceKey)
      if (old !== undefined) {
        this.updateCut(old, sourceKey, undefined)
        this.cutBuckets.delete(sourceKey)
        this.cutAt.delete(sourceKey)
      }
      const source =
        body?.kind === 'semantic-work' &&
        body.source.kind === 'submission' &&
        state.submissions.get(body.source.clientMessageId)
      const original = this.origins.get(this.submissionWork.get(itemId) ?? itemId)
      if (
        body?.kind === 'semantic-work' &&
        ((original &&
          (!isDeepStrictEqual(original.source, body.source) ||
            original.startedAt !== body.startedAt)) ||
          agentJournalItemKey({
            provider: 'legacy',
            agent: state.agent ?? '',
            sessionId: state.sessionId,
            recordId: semanticWorkRecordId(body.source)
          }) !== (this.submissionWork.get(itemId) ?? itemId) ||
          (body.source.kind === 'submission' && (!source || source.submittedAt !== body.startedAt)))
      ) {
        throw new Error('semantic work source mismatch')
      }
      if (body?.kind === 'semantic-work' && !original) {
        this.origins.set(this.submissionWork.get(itemId) ?? itemId, body)
      }
      const phase =
        body?.kind === 'semantic-work'
          ? body.phase
          : turn && isRootAgentJournalItem(item)
            ? turn.state === 'running'
              ? 'open'
              : turn.state !== 'completed' || turn.outcome === 'cancellation'
                ? 'interrupted'
                : 'settled'
            : submission && submission.dispatchState !== 'rejected'
              ? submission.recovered
                ? 'interrupted'
                : 'open'
              : submission?.recovered
                ? 'interrupted'
                : 'settled'
      const fact = {
        itemId,
        since:
          body?.kind === 'semantic-work'
            ? body.startedAt
            : (submission?.submittedAt ??
              turn?.startedAt ??
              turn?.requestedAt ??
              item?.observedAt ??
              0)
      }
      let attached = false
      if (!turn) {
        for (const id of this.linked(sourceKey)) {
          if (readAgentJournalTurn(state.items.get(id)?.body)) {
            attached = true
            break
          }
        }
      }
      const work = item
        ? {
            fact,
            item:
              submission || source
                ? { ...item, sequence: (submission || source).submittedSequence ?? item.sequence }
                : item
          }
        : undefined
      this.active.update(
        sourceKey,
        phase === 'open' && !attached && item && item.sequence > this.floor ? work : undefined
      )
      if (item && item.sequence > this.floor && !attached) {
        if (phase === 'interrupted') {
          const frontier =
            body?.kind === 'semantic-work'
              ? (state.aliases.get(body.afterRequest ?? '') ?? body.afterRequest ?? '')
              : (originalCut ?? this.frontier() ?? '')
          const linked = this.linked(frontier, true)
          linked.add(itemId)
          let at = frontier
          while (
            at &&
            (!this.requests.has(at) || this.requests.get(at)?.retired) &&
            this.predecessors.has(at)
          ) {
            at = this.predecessors.get(at) ?? ''
          }
          this.updateCut(at, sourceKey, work)
          this.cutAt.set(sourceKey, frontier)
          this.cutBuckets.set(sourceKey, at)
        }
      }
    }
    if (oldFloor !== this.floor) {
      this.legacy = undefined
      this.dirty = true
      for (const key of this.active.entries.keys()) {
        this.observe(state, key, visiting)
      }
      for (const key of this.cutAt.keys()) {
        this.observe(state, key, visiting)
      }
    }
    // Command identity is resolved by the same selector as the sidebar, including late imports.
    for (const linked of this.linked(itemId)) {
      if (linked !== itemId) {
        this.observe(state, linked, visiting)
      }
    }
    if (turn?.userItemId && requestSourceId !== itemId) {
      this.observe(state, requestSourceId, visiting)
    }
  }
}
