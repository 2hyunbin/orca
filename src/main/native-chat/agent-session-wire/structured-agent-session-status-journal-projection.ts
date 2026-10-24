import {
  atRestStructuredStatusSummary,
  type StructuredAgentSessionAtRest
} from './structured-agent-session-status-summary'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/structured-agent-session-command-entry'
// The status feed's per-journal projection, cached per commit: what a session's journal says its
// row is, and the user's newest send the provider accepted.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  structuredAgentSessionCurrentWork,
  structuredAgentSessionReplacedRuntimeEnded,
  type StructuredAgentSessionWorkEvidence
} from './structured-agent-session-current-work'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'
import { structuredAgentSessionStopping } from './structured-agent-session-stopping'

export type StructuredAgentSessionStatusState = ReturnType<
  typeof projectStructuredAgentSessionStatusState
>

export type StructuredAgentSessionJournalProjection = {
  epoch: string
  sequence: number
  fence: number | undefined
  /** The live generation's fence (`structuredAgentSessionLiveFence`): an exit this host saw, or a
   *  release, changes what is current without a journal row. */
  liveFence: number | null
  /** `StructuredAgentSessionCurrentWork.revision`: what this host saw end with no row or lease
   *  write still changes the row. */
  restored: unknown
  workRevision: number
  /** The Stop marks' settle revision: a settle edge writes no row, so it is a key of its own. */
  stopRevision: number
  state: StructuredAgentSessionStatusState
  acceptedSendKey: string
  firstInputSubmissionKey: string | null
  submissionCount: number
  /** A person's Stop is still ending the work it stopped (`structuredAgentSessionStopping`). */
  stopping: boolean
}

export class StructuredAgentSessionJournalProjections {
  private readonly restored = new Map<
    string,
    {
      rest: StructuredAgentSessionAtRest
      baseline?: { epoch: string; revision: number }
    }
  >()

  noteRestart(sessionId: string, rest: StructuredAgentSessionAtRest): void {
    const previous = this.restored.get(sessionId)
    if (!previous || (previous.rest.known === false && rest.known !== false)) {
      this.restored.set(sessionId, { rest, baseline: previous?.baseline })
    }
  }

  // Task progress must not sort and scan an unchanged conversation. Journal identity owns cleanup.
  private readonly byJournal = new WeakMap<
    AgentSessionJournal,
    StructuredAgentSessionJournalProjection
  >()

  /** `AgentSessionRecordStore.replacedRuntime`, which ends what a replaced runtime held. */
  constructor(
    private readonly replacedRuntime?: (
      sessionId: string
    ) => StructuredAgentSessionWorkEvidence['replaced']
  ) {}

  read(
    journal: AgentSessionJournal,
    record: AgentSessionRecord | null,
    /** What this host saw end (`StructuredAgentSessionHostSession`). */
    seen?: {
      lastEndedChild?: StructuredAgentSessionWorkEvidence['ended']
      operationalRevision?: number
      child?: StructuredAgentSessionWorkEvidence['child']
    }
  ): StructuredAgentSessionJournalProjection {
    const cursor = journal.cursor()
    // The conversation's fence, which a child's end moves: its unanswered sends stop counting.
    const fence = record?.lease.runtimeFence
    const ended = seen?.lastEndedChild
    const work = structuredAgentSessionCurrentWork(journal, {
      record,
      replaced: record ? this.replacedRuntime?.(record.sessionId) : undefined,
      child: seen?.child ?? null,
      ...(ended ? { ended } : {}),
      revision: seen?.operationalRevision ?? 0
    })
    const stopRevision = journal.stopMarks.revision()
    let projection = this.byJournal.get(journal)
    if (
      !projection ||
      projection.epoch !== cursor.epoch ||
      projection.sequence !== cursor.sequence ||
      projection.fence !== fence ||
      projection.liveFence !== work.liveFence ||
      projection.workRevision !== work.revision ||
      projection.stopRevision !== stopRevision ||
      projection.restored !== this.restored.get(journal.sessionId)
    ) {
      // A journalled submission bumps `lastSequence`, so the send-time working
      // signal reaches the cache; the lease fence does not, hence the extra key.
      const snapshot = journal.snapshot()
      let firstInputSubmissionKey =
        projection?.epoch === cursor.epoch ? projection.firstInputSubmissionKey : null
      const start = projection?.epoch === cursor.epoch ? projection.submissionCount : 0
      const submissions =
        !firstInputSubmissionKey && snapshot.submissions.length !== start
          ? journal.submissions()
          : snapshot.submissions
      // New submissions are visited once; streamed output cannot rescan command history.
      for (let index = start; !firstInputSubmissionKey && index < submissions.length; index++) {
        const submission = submissions[index]
        const item =
          journal.item(agentJournalSubmissionKey(submission.clientMessageId)) ??
          (submission.providerItemId ? journal.item(submission.providerItemId) : null)
        if (
          item?.body.kind === 'message' &&
          item.body.role === 'user' &&
          isRootAgentJournalItem(item) &&
          !isStructuredAgentSessionCommandEntry(item.body)
        ) {
          firstInputSubmissionKey = JSON.stringify([cursor.epoch, submission.clientMessageId])
        }
      }
      projection = {
        ...cursor,
        restored: this.restored.get(journal.sessionId),
        firstInputSubmissionKey,
        submissionCount: snapshot.submissions.length,
        fence,
        liveFence: work.liveFence,
        workRevision: work.revision,
        stopRevision,
        // The host's projection of current work: an ended generation's is not Working.
        state: withDiedTurnVerdict(
          projectStructuredAgentSessionStatusState(
            snapshot.items,
            snapshot.submissions.map(work.publishedSubmission),
            fence,
            work.scope
          ),
          work.diedTurn()
        ),
        acceptedSendKey: newestAcceptedSendKey(cursor.epoch, snapshot.submissions),
        stopping: structuredAgentSessionStopping(
          journal,
          snapshot.items,
          snapshot.submissions,
          work.scope
        )
      }
      projection.state = this.restartVerdict(
        projection.state,
        journal,
        record,
        seen?.child !== undefined && seen.child !== null
      )
      this.byJournal.set(journal, projection)
    }
    return projection
  }
  private restartVerdict(
    state: StructuredAgentSessionStatusState,
    journal: AgentSessionJournal,
    record: AgentSessionRecord | null,
    liveChild: boolean
  ): StructuredAgentSessionStatusState {
    if (!record) {
      return state
    }
    const id = record.sessionId
    if (liveChild) {
      this.restored.delete(id)
    }
    const presentation = this.restored.get(id)
    const version = { epoch: journal.epoch, revision: journal.restRevision() }
    if (presentation) {
      const before = presentation.baseline ?? {
        epoch: journal.epoch,
        revision: journal.openedRestRevision
      }
      if (before && (before.epoch !== version.epoch || before.revision !== version.revision)) {
        this.restored.delete(id)
      } else {
        presentation.baseline = version
        const rest = presentation.rest
        const saved = atRestStructuredStatusSummary(record, rest, { now: () => rest.lastSavedAt })
        return {
          ...state,
          summary: {
            ...state.summary,
            status: saved.status,
            turnOutcome: saved.turnOutcome,
            restoredInterruption: saved.restoredInterruption,
            statusStartedAt: saved.statusStartedAt
          }
        }
      }
    }
    const cut = journal.restFact()
    const replaced = this.replacedRuntime?.(id)
    const fence = cut && journal.itemFence(cut.itemId)
    const ended =
      !liveChild &&
      (!!record.lease.deathEvidence?.runtimeEnd ||
        (replaced &&
          structuredAgentSessionReplacedRuntimeEnded(record.lease, replaced) &&
          fence !== undefined &&
          fence !== null &&
          fence <= replaced.fence))
    return cut && ended && (state.summary.status === 'idle' || state.summary.status === null)
      ? {
          ...state,
          summary: {
            ...state.summary,
            status: 'idle',
            turnOutcome: 'cancellation',
            restoredInterruption: true,
            statusStartedAt: cut.since
          }
        }
      : state
  }
}

/** A turn whose generation died on its own reads as its settlement writes it, interrupted, before
 *  that lands: never a finish with no verdict (`StructuredAgentSessionCurrentWork.diedTurn`). */
function withDiedTurnVerdict(
  state: StructuredAgentSessionStatusState,
  died: { turnId: string } | null
): StructuredAgentSessionStatusState {
  const request = state.latestRequest
  return died &&
    state.summary.status === 'idle' &&
    request?.kind === 'turn' &&
    request.id === died.turnId &&
    request.turnState === 'running'
    ? { ...state, summary: { ...state.summary, turnOutcome: 'interruption' } }
    : state
}
