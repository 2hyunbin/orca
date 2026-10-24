import { isDeepStrictEqual } from 'node:util'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { semanticWorkRecordId } from '../../../shared/agent-session-semantic-work'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'
import { JournalRestObservation, type ObservationFrame } from './journal-rest-observation'

export abstract class JournalRestWorkProjection extends JournalRestObservation {
  protected trackWork(state: JournalReducerState, key: string, sequence: number): void {
    const sourceSequence = state.items.get(key)?.sequence ?? sequence
    this.selection.groups.update(
      'floorRechecks',
      key,
      (this.active.entries.has(key) || this.cutAt.has(key)) &&
        sourceSequence <= this.floor &&
        sequence > this.floor
    )
    for (const [name, present] of [
      ['workActive', this.active.entries.has(key)],
      ['workCuts', this.cutAt.has(key)]
    ] as const) {
      const previous = this.selection.tree.candidate(name, key)
      const ordinal = previous?.ordinal ?? this.selection.nextOrdinal(name)
      this.selection.tree.update(
        name,
        key,
        present ? { key, rank: sourceSequence, ordinal, time: sourceSequence } : undefined
      )
    }
  }

  protected observeWork(
    state: JournalReducerState,
    itemId: string,
    sourceKey: string,
    item: AgentJournalRenderItem | undefined,
    body: AgentJournalRenderItem['body'] | undefined,
    submission: AgentJournalSubmission | undefined,
    turn: ReturnType<typeof readAgentJournalTurn>
  ): Extract<ObservationFrame, { kind: 'lineage' }> | undefined {
    let pendingCut: Extract<ObservationFrame, { kind: 'lineage' }> | undefined
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
        this.selection.tree.update('workCuts', sourceKey, undefined)
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
      const attached = !turn && this.selection.groups.has(`turns:${sourceKey}`)
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
          this.selection.groups.update(`links:${frontier}`, itemId, true)
          pendingCut = {
            kind: 'lineage',
            itemId,
            sourceKey,
            frontier,
            at: frontier,
            work,
            sequence: item.sequence
          }
        }
      }
    }
    this.trackWork(state, sourceKey, item?.sequence ?? 0)
    return pendingCut
  }
}
