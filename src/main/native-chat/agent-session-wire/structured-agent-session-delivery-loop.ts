import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'
// The one thing that starts a provider child for a send, the one thing that hands a message to
// it, and the one thing that settles a queued message because of a start, a child or a leftover.
//
// A send is accepted on its own serialized step and returns; this loop does the rest. It exists
// for a session exactly while a message is queued there — accepted, not yet handed over — and no
// child is running a conversation command: a command's turn takes no input, and the commit that
// ends it wakes the loop again. Every step re-reads the journal and the conversation's child
// record to decide, so there is no loop state to disagree with them. Each step is its own
// serialized task, and the waits between them — the agent's start, its readiness, the provider
// call — run outside the serialize, so a send is accepted while they last, and a Stop that arrives
// meanwhile withdraws the queued messages before the handover that would have written them. Stop
// and the conversation's close are the only other writers of a
// queued message: a child's exit only ends the child, and this loop reads why. A message an
// earlier host process left queued is never handed over: the open, or this loop's first step,
// settles it first (`journal-unsent-send-hold.ts`).

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import type { StructuredAgentSessionStartClaim } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import {
  oldestQueuedSubmission,
  recordStructuredAgentSessionStartFailure,
  startThatFailedWhileQueued
} from './structured-agent-session-start-failure-row'
import {
  beginSubmissionHandover,
  type StructuredAgentSessionPendingHandover
} from './structured-agent-session-handover'
import { structuredAgentSessionNextHandover } from './structured-agent-session-opening-send'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-startup-attempt'
import { holdRestartedStructuredAgentSessionSends } from './structured-agent-session-host-lifetime'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import { waitsForCodexTurnOptions } from './structured-agent-session-message-options'
import { sameProviderChild } from './structured-agent-session-provider-child'

export type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'

type Prepared =
  | 'stop'
  | 'continue'
  | { start: StructuredAgentSessionStartClaim }
  | {
      ok: true
      awaited: StructuredAgentSessionProviderChildIdentity
      clientMessageId: string
      readiness: StructuredAgentSessionStartReadiness | null
      before: Promise<void>
    }

/** A failed start before it is worded; `fail` words it once, through the one wording point. */
type StartFailure = NonNullable<ReturnType<typeof startThatFailedWhileQueued>>

export class StructuredAgentSessionDeliveryLoop {
  private readonly running = new Set<string>()
  private readonly runs = new Map<string, Promise<void>>()
  private disposed = false

  constructor(private readonly deps: StructuredAgentSessionDeliveryLoopDeps) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Quit: no step after this one starts a child or hands a message over. */
  dispose(): void {
    this.disposed = true
    this.deps.deliveryOrder.dispose()
  }

  /** From inside the session's serialize, after a message was accepted or the conversation
   *  opened. A loop already running re-reads the journal on its next step. Settles once the loop
   *  has handed over all it can; never rejects. */
  wake(sessionId: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    this.deps.deliveryOrder.reconcile(
      sessionId,
      this.deps.sessions.get(sessionId)?.journal.submissions() ?? []
    )
    if (this.running.has(sessionId)) {
      return this.runs.get(sessionId) ?? Promise.resolve()
    }
    this.running.add(sessionId)
    const run = this.run(sessionId).finally(() => {
      if (this.runs.get(sessionId) === run) {
        this.runs.delete(sessionId)
      }
    })
    this.runs.set(sessionId, run)
    return run
  }

  private async run(sessionId: string): Promise<void> {
    try {
      for (;;) {
        const prepared = await this.deps.trackStart(
          this.deps.serialize(sessionId, () => this.prepare(sessionId))
        )
        if (prepared === 'stop') {
          return
        }
        if (prepared === 'continue') {
          continue
        }
        if ('start' in prepared) {
          // Outside the serialize: sends are accepted while the agent starts.
          const completed = await prepared.start.outcome.then(
            () => true,
            (error: unknown) => {
              this.deps.logger.warn('waiting for an agent start failed', { sessionId, error })
              return false
            }
          )
          if (!completed) {
            await this.deps
              .serialize(sessionId, async () => this.stop(sessionId))
              .catch((error: unknown) =>
                this.deps.logger.warn('parking delivery after a failed start failed', {
                  sessionId,
                  error
                })
              )
            return
          }
          // The flight settled its requester; joiners rederive their own work.
          continue
        }
        if (prepared.readiness) {
          await prepared.readiness.wait()
        }
        await prepared.before
        const handed = await this.deps.serialize(sessionId, () =>
          this.handOver(
            sessionId,
            prepared.awaited,
            prepared.clientMessageId,
            prepared.readiness !== null
          )
        )
        if (handed === 'stop') {
          return
        }
        if (handed !== 'continue') {
          // The provider call runs outside; its resolution is the next commit. Tracked, so quit's
          // drain waits for both after its abort ends the call.
          await this.deps.trackStart(
            handed
              .dispatch()
              .then((resolve) => this.deps.serialize(sessionId, resolve))
              .finally(() => handed.release?.())
          )
        }
      }
    } catch (error) {
      // The error is Orca's own and goes to the log; the chat says only that Orca failed.
      this.deps.logger.warn('delivering a queued message failed', {
        scope: 'delivery-loop',
        sessionId,
        error
      })
      const cause = { hostFault: true } as const
      await this.deps
        .serialize(sessionId, async () => {
          try {
            const session = this.deps.sessions.get(sessionId)
            const selected = session && oldestQueuedSubmission(session)
            await this.fail(sessionId, { startKey: null, cause }, selected?.clientMessageId ?? null)
          } finally {
            this.stop(sessionId)
          }
        })
        .catch((failure: unknown) => {
          // Rows left queued go to the next loop an accept wakes, or the next open settles them.
          this.deps.logger.warn('recording a failed delivery failed', {
            scope: 'delivery-loop-fail',
            sessionId,
            error: failure
          })
        })
    }
  }

  /** Settles what an earlier host process left queued, then makes the session ready. */
  private async prepare(sessionId: string): Promise<Prepared> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    // The open already did, unless its write failed: a row an earlier handle wrote is never handed
    // over, whether it outlived a quit or a crash. A failure here throws, so none is: this run then
    // fails, which rejects every queued send, this process's own too.
    await holdRestartedStructuredAgentSessionSends(
      this.deps.logger,
      sessionId,
      session.journal,
      this.deps.conversationFence(sessionId)
    )
    if (!(await this.deps.closeWhatTheUserClosed(sessionId))) {
      // Never start an agent for a message the user closed; the next wake re-derives and retries.
      return this.stop(sessionId)
    }
    const oldest = oldestQueuedSubmission(session)
    // A running command takes no input while its child carries it; its end is a commit, which
    // wakes the loop again. With no child it is a gone generation's, which the start below settles.
    const work = this.deps.currentWork(sessionId)
    if (!oldest || (session.child && work && structuredAgentSessionCommandRunning(work))) {
      return this.stop(sessionId)
    }
    if (this.deps.startFlights?.has(sessionId)) {
      return { start: this.deps.startProviderChild(sessionId, oldest.clientMessageId) }
    }
    const failedStart = startThatFailedWhileQueued(session, oldest)
    if (failedStart) {
      return this.fail(sessionId, failedStart, oldest.clientMessageId)
    }
    await this.deps.retireOutgrownChild(sessionId)
    const child = this.deps.sessions.get(sessionId)?.child
    if (!child || child.close) {
      return {
        start: this.deps.startProviderChild(sessionId, oldest.clientMessageId)
      }
    }
    // The child this run waits on; handover checks it is still the one there.
    return {
      ok: true,
      awaited: { generation: child.generation, fence: child.fence },
      clientMessageId: oldest.clientMessageId,
      readiness: child.phase === 'starting' ? this.deps.readiness(sessionId, child) : null,
      before: this.deps.deliveryOrder.beforeSend(sessionId, oldest.clientMessageId)
    }
  }

  private async handOver(
    sessionId: string,
    awaited: StructuredAgentSessionProviderChildIdentity,
    clientMessageId: string,
    waited: boolean
  ): Promise<'continue' | 'stop' | StructuredAgentSessionPendingHandover> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    // Re-derived here, not carried from the start: the child may have ended, or another may have
    // taken its place, since.
    const { child } = session
    const awaitedChild = child && sameProviderChild(child, awaited) ? child : null
    if (!awaitedChild) {
      // The child started for this message is gone or replaced by another.
      const ended = session.lastEndedChild
      const endedFailure = ended ? structuredAgentSessionEndedChildFailure(ended) : undefined
      // A user's Stop or close is not a failure: the next step starts, or waits on, a child for
      // what is queued, after closing what a close of the chat closed.
      if (endedFailure === null) {
        return 'continue'
      }
      return this.fail(
        sessionId,
        {
          startKey: awaited.generation,
          cause: endedFailure ??
            // Gone with no end observed: nothing says the provider stopped.
            { failure: agentSessionFailureFact('startFailed') }
        },
        clientMessageId
      )
    }
    // Never steer into a turn a person's Stop is ending: the message runs after it, as its own
    // turn, and the turn's end is a commit that wakes the loop again. Read here, at the handover,
    // because a Stop can take the lane between the step that judged the send and this one.
    if (this.deps.stopping(sessionId) || awaitedChild.phase !== 'ready') {
      return this.stop(sessionId)
    }
    // None while a turn is still opening: joining it would record the message ahead of it.
    const work = this.deps.currentWork(sessionId)
    const next = structuredAgentSessionNextHandover(session, awaitedChild.fence, work)
    if (!next) {
      return this.stop(sessionId)
    }
    if (waited) {
      // Re-check launch permission only after proving the awaited child still exists.
      await this.deps.retireOutgrownChild(sessionId)
      if (session.child !== awaitedChild) {
        return 'continue'
      }
    }
    if (
      waitsForCodexTurnOptions(this.deps.record(sessionId), session.journal, next, awaitedChild)
    ) {
      return this.stop(sessionId)
    }
    const pending = await beginSubmissionHandover(
      {
        sessionId,
        journal: session.journal,
        fence: awaitedChild.fence,
        adapter: this.deps.adapter,
        agents: this.deps.agents,
        failureTextContext: this.deps.failureTextContext(sessionId),
        record: () => this.deps.record(sessionId),
        currentWork: () => this.deps.currentWork(sessionId),
        childWork: () => this.deps.readChildWork(sessionId),
        childWorkOpen: () => this.deps.childWorkOpen(sessionId),
        now: this.deps.now,
        acquireAborts: this.deps.acquireAborts,
        deliveryOrder: this.deps.deliveryOrder,
        workChanged: () => this.deps.workChanged?.(sessionId),
        recordRanOptions: this.deps.recordRanOptions?.(sessionId, awaitedChild.fence)
      },
      next,
      // Re-read right before the provider call, which runs outside the serialize.
      () => this.deps.sessions.get(sessionId)?.child === awaitedChild && !awaitedChild.close
    )
    return pending ?? 'continue'
  }

  private async fail(
    sessionId: string,
    failure: StartFailure,
    clientMessageId: string | null
  ): Promise<'continue'> {
    const session = this.deps.sessions.get(sessionId)
    if (session) {
      await recordStructuredAgentSessionStartFailure(
        { journal: session.journal, fence: this.deps.conversationFence(sessionId) },
        {
          startKey: failure.startKey,
          ...structuredAgentSessionStartFailure(
            failure.cause,
            this.deps.failureTextContext(sessionId)
          )
        },
        clientMessageId
      )
    }
    return 'continue'
  }

  /** Inside the serialized step that found nothing to do, so an accept after it wakes anew. */
  private stop(sessionId: string): 'stop' {
    this.running.delete(sessionId)
    this.deps.deliveryOrder.parkSends(sessionId)
    return 'stop'
  }
}
