import { createJournalSourceReads } from './journal-source-reads'
import { createJournalCurrentWorkView } from './journal-current-work-view'
// Append-only journal store for one agent session. It owns the chat's fold and write queue, and no
// connection: every statement goes through the host's one journal database.

import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import { randomUUID } from 'node:crypto'
import { createJournalPublicReader } from './journal-public-read'
import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalSnapshot,
  AgentJournalSubmission,
  AgentJournalThreadGoal,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readJournalSince } from './journal-cursor'
import type { JournalHostDatabase } from './journal-host-database'
import { journalRowsAfterReader, type JournalLoad } from './journal-open'
import {
  markJournalPendingSubmissionsUnknown,
  rejectJournalPendingSubmissions,
  rejectJournalQueuedSubmissions
} from './journal-pending-submission-recovery'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import { journalTombstoneRowBuilder } from './journal-row-builders'
import type {
  AgentSessionJournalOptions,
  JournalAppendResult,
  JournalItemAppendOptions,
  JournalLifecycleBatchInput,
  JournalPlannedLifecycleBatchInput,
  JournalReadSince,
  JournalSubmissionConsume,
  JournalSubmissionInput,
  JournalTombstoneInput,
  ResolveDispatchInput
} from './journal-store-contracts'
import type { JournalQueuedMessages, JournalQueuePlan } from './journal-queued-messages'
import {
  journalQueueResumeRowBuilder,
  journalQueueReopenRowBuilder,
  journalStopEventRowBuilder
} from './journal-stop-and-resume-rows'
import type { AgentJournalEpochReason, JournalStopEvent, JournalRow } from './journal-row-schema'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import type { JournalSubmissionWriter } from './journal-submission-writer'
import type { JournalEpochController } from './journal-epoch-controller'
import { JournalWriteQueue } from './journal-write-queue'
import { createJournalStoreCollaborators } from './journal-store-collaborators'
import type { JournalItemAppender } from './journal-item-appender'
import type { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalStepWriter } from './journal-step-writer'
import type { JournalStopMarks } from './journal-stop-marks'
import type { JournalContextController } from './journal-context-controller'
import type { JournalStopAcceptor } from './journal-stop-acceptance'

export { AgentSessionJournalError } from './journal-write-guards'

export class AgentSessionJournal {
  private readonly identity: AgentSessionJournalIdentity
  private readonly database: JournalHostDatabase
  private readonly now: () => number
  private readonly mintEpoch: () => string

  private state: JournalReducerState
  private readonly readPublic = createJournalPublicReader()
  private openedThrough: AgentJournalCursor = { epoch: '', sequence: 0 }
  private reopenUnmarked: AgentJournalCursor | null = null
  private onCommitted: ((rows?: readonly JournalRow[]) => void) | null = null
  private readonly queue: JournalWriteQueue
  private readonly sourceReads = createJournalSourceReads(() => this.state)
  private readonly currentWorkView = createJournalCurrentWorkView(() => this.state)
  private readonly rowWriter: JournalRowWriter
  private readonly epochController: JournalEpochController
  private readonly itemAppender: JournalItemAppender
  private readonly lifecycleBatchAppender: JournalLifecycleBatchAppender
  private readonly submissionWriter: JournalSubmissionWriter
  private readonly stepWriter: JournalStepWriter
  private readonly restore: () => Promise<void>
  /** Queued cards never count as owed work. */
  readonly queuedMessages: JournalQueuedMessages
  readonly stopMarks: JournalStopMarks
  readonly stops: JournalStopAcceptor
  readonly context: JournalContextController

  constructor(options: AgentSessionJournalOptions) {
    this.identity = options.identity
    this.database = options.database
    this.now = options.now ?? (() => Date.now())
    this.mintEpoch = options.mintEpoch ?? randomUUID
    this.state = createJournalReducerState(options.identity.sessionId, '')
    this.queue = new JournalWriteQueue(options.identity.sessionId)
    const collaborators = createJournalStoreCollaborators({
      identity: this.identity,
      legacyCursor: options.legacyCursor,
      now: this.now,
      mintEpoch: this.mintEpoch,
      serialize: (run) => this.queue.serialize(run),
      database: () => this.database,
      state: () => this.state,
      readOnly: () => this.database.readOnly,
      cursor: this.cursor,
      adopt: (loaded) => {
        this.adoptLoadedJournal(loaded)
        this.onCommitted?.()
      },
      commit: (rows, savedAt) => {
        for (const row of rows) {
          applyJournalRow(this.state, row, savedAt)
        }
        this.state.rest.fact()
        this.onCommitted?.(rows)
      },
      notifyCommitted: () => this.onCommitted?.([]),
      journal: () => this,
      enqueue: (build, receipt) => this.rowWriter.enqueue(build, receipt)
    })
    this.rowWriter = collaborators.rowWriter
    this.epochController = collaborators.epochController
    this.itemAppender = collaborators.itemAppender
    this.lifecycleBatchAppender = collaborators.lifecycleBatchAppender
    this.submissionWriter = collaborators.submissionWriter
    this.stepWriter = collaborators.stepWriter
    this.queuedMessages = collaborators.queuedMessages
    this.stopMarks = collaborators.stopMarks
    this.stops = collaborators.stops
    this.restore = collaborators.restore
    this.context = collaborators.context
  }

  openedRestRevision = 0
  restRevision = () => this.state.rest.revision
  restFact = () => this.state.rest.fact()
  requestFrontier = () => this.state.rest.frontier()
  retainedRequestFrontier = (anchor: string | null, retained: ReadonlySet<string>) =>
    this.state.rest.retainedFrontier(anchor, retained)

  get epoch(): string {
    return this.state.epoch
  }

  get agent(): AgentSessionJournalIdentity['agent'] {
    return this.identity.agent
  }

  get sessionId(): string {
    return this.identity.sessionId
  }

  /** Whether a row at this sequence was on disk when this handle opened, so an earlier handle
   *  wrote it. Sequences restart with each epoch, so a row of a later epoch never was. */
  wroteBeforeOpen(sequence: number | undefined): boolean {
    return (
      sequence !== undefined &&
      this.state.epoch === this.openedThrough.epoch &&
      sequence <= this.openedThrough.sequence
    )
  }

  /** Where the reopen's pause begins when this handle could not write its mark: where the mark
   *  would have gone. Null once a mark is written. Per handle, so the next open marks again. */
  reopenFloor = (): AgentJournalCursor | null => this.reopenUnmarked

  restoreReopenFloor = (floor: AgentJournalCursor | null) => (this.reopenUnmarked = floor)

  async open(): Promise<void> {
    await this.restore()
    this.openedThrough = this.cursor()
    this.openedRestRevision = this.state.rest.revision
  }

  /** Refuse future writes and drain admitted ones; the host retains database ownership. */
  close(): Promise<void> {
    this.queuedMessages.editLeases.dispose()
    this.queue.markClosed()
    return this.queue.drain()
  }

  /** One nonthrowing listener; undefined rows mean adopted history, an empty array means metadata. */
  observeCommits(listener: (rows?: readonly JournalRow[]) => void): void {
    this.onCommitted = listener
  }

  cursor = (): AgentJournalCursor => ({
    epoch: this.state.epoch,
    sequence: this.state.lastSequence
  })

  snapshot = (): AgentJournalSnapshot => this.publicRead().snapshot

  publicRead = () =>
    this.readPublic(
      this.state,
      this.queuedMessages.displayState(),
      this.queuedMessages.revision(),
      () => this.queuedMessages.normalizationKey()
    )

  visitItems = this.sourceReads.visitItems
  itemBody = this.sourceReads.itemBody
  stoppedHistoryCarried = this.sourceReads.stoppedHistoryCarried
  item = this.sourceReads.item
  visitItemsWithLinkage = this.sourceReads.visitItemsWithLinkage

  /** The turn this journal records as running, with its record's item, whichever generation
   *  opened it — the same read a client's snapshot gives, without materialising one. Whether it is
   *  current work is the host projection's to say (`structuredAgentSessionCurrentWork`). */
  runningTurn = this.currentWorkView.runningTurn

  /** The newest turn record whatever state it settled in, for readers that need the outcome. */
  newestTurn = this.currentWorkView.newestTurn

  /** The latest goal and its row, for a provider revising accounting after restart. */
  threadGoalSource = this.currentWorkView.threadGoalSource

  /** Read across the journal, beyond any client's loaded page. */
  threadGoal = (): AgentJournalThreadGoal | null => this.threadGoalSource().goal

  /** The newest context facts the whole journal records, not only a client's loaded page. */
  contextUsage = this.currentWorkView.contextUsage

  lastActivityAt = this.sourceReads.lastActivityAt
  itemFence = this.sourceReads.itemFence
  itemProvenance = this.sourceReads.itemProvenance
  lastProviderActivityAt = this.sourceReads.lastProviderActivityAt
  submissionVersion = this.sourceReads.submissionVersion
  submissions = this.sourceReads.submissions
  historyOrigin = this.sourceReads.historyOrigin
  submission = this.sourceReads.submission
  submissionAtItem = this.sourceReads.submissionAtItem
  pendingSubmissions = this.sourceReads.pendingSubmissions
  receiptFor = this.sourceReads.receiptFor
  canonicalItemId = this.sourceReads.canonicalItemId

  /** Read after all preceding writes and before later ones. */
  readInOrder<T>(read: () => T): Promise<T> {
    return this.queue.readInOrder(read)
  }

  readSince(cursor: AgentJournalCursor, limit?: number): JournalReadSince {
    const { sessionId } = this.identity
    const rowsAfter = journalRowsAfterReader(this.database.db, sessionId, this.state.epoch, limit)
    return readJournalSince({ state: this.state, rowsAfter }, cursor, () => this.cursor())
  }

  /** Assign revisions here so callers cannot publish reducer-stale upserts. */
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions,
    receipt?: JournalOperationReceipt
  ): Promise<JournalAppendResult> {
    return this.itemAppender.append(identity, body, options, receipt)
  }

  /** Resolve on the write lane; null appends nothing. */
  appendResolvedItem: JournalItemAppender['appendResolved'] = (resolve, options) =>
    this.itemAppender.appendResolved(resolve, options)

  appendTombstone(
    identity: AgentJournalItemIdentity,
    { fence }: JournalTombstoneInput
  ): Promise<AgentJournalCursor> {
    const itemId = agentJournalItemKey(identity)
    return this.rowWriter.append(journalTombstoneRowBuilder(() => this.state, itemId, fence))
  }

  appendStopEvent(event: Omit<JournalStopEvent, 'at'>, fence: number): Promise<AgentJournalCursor> {
    return this.rowWriter.append(journalStopEventRowBuilder(() => this.state, event, fence))
  }

  appendQueueResume(fence: number, receipt?: JournalOperationReceipt): Promise<AgentJournalCursor> {
    const build = journalQueueResumeRowBuilder(() => this.state, fence)
    return this.rowWriter.append(build, receipt)
  }

  appendQueueReopen(fence: number, since?: number): Promise<AgentJournalCursor> {
    return this.rowWriter.append(journalQueueReopenRowBuilder(() => this.state, fence, since))
  }

  /** Mark preexisting cards; failed writes retain a conservative reopenFloor and throw. */
  async markQueueReopen(fence: number, since?: number): Promise<void> {
    if (this.queuedMessages.awaitReopenMark()) {
      const sequence = since ?? this.state.lastSequence + 1
      this.reopenUnmarked = { epoch: this.state.epoch, sequence }
      await this.appendQueueReopen(fence, since)
      this.reopenUnmarked = null
    }
  }

  appendLifecycleBatch(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.lifecycleBatchAppender.append(input)
  }

  appendPlannedLifecycleBatch = (input: JournalPlannedLifecycleBatchInput) =>
    this.lifecycleBatchAppender.appendPlanned(input)

  /** Several writes as one turn in the queue; see `JournalStepWriter`. */
  appendSteps: JournalStepWriter['append'] = (steps, onWritten) =>
    this.stepWriter.append(steps, onWritten)

  appendSubmission(
    input: JournalSubmissionInput,
    consume?: JournalSubmissionConsume,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    return this.submissionWriter.append(input, consume, receipt)
  }

  resolveDispatch(
    input: ResolveDispatchInput,
    cards?: () => JournalQueuePlan
  ): Promise<AgentJournalCursor> {
    return this.submissionWriter.resolveDispatch(input, cards)
  }

  acceptLate: JournalSubmissionWriter['acceptLate'] = (i) => this.submissionWriter.acceptLate(i)

  /** Retire unanswered sends after their execution owner ended, without assuming delivery. */
  async markPendingSubmissionsUnknown(fence: number, reason?: string): Promise<string[]> {
    return markJournalPendingSubmissionsUnknown(this, fence, reason)
  }

  /** Failed initialization proves handed-over but unanswered sends never ran. */
  async rejectPendingSubmissions(
    fence: number,
    rejection: AgentJournalDispatchRejection
  ): Promise<string[]> {
    return rejectJournalPendingSubmissions(this, fence, rejection)
  }

  rejectQueuedSubmissions = (
    fence: number,
    rejection: AgentJournalDispatchRejection,
    which?: (submission: AgentJournalSubmission) => boolean
  ): Promise<string[]> => rejectJournalQueuedSubmissions(this, fence, rejection, which)

  /** Epoch rollover invalidates every client cursor. */
  async rollEpoch(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.epochController.roll(reason, fence)
  }

  replaceEpochItems(
    ...args: Parameters<JournalEpochController['replace']>
  ): Promise<AgentJournalCursor> {
    return this.epochController.replace(...args)
  }

  private adoptLoadedJournal(loaded: JournalLoad): void {
    this.state = loaded.state
  }
}
