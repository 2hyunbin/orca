// The one thing that puts an idle agent to rest.
//
// Nothing a viewer does keeps an agent alive or starts one: a chat on screen and a chat in a
// background tab are the same to this sweep. Every few minutes it looks at each open conversation
// and stops the provider child of one that has been quiet for the idle window and owes no work,
// then drops the in-memory fold of one that is only a cache. The conversation itself — its
// record, tab, status row and readers — is untouched, and the next send starts a new child.
//
// Owed work is derived on every tick, never stored, so there is nothing to disagree with it.
//
// It also bounds how many folds are resident at once: opening a chat past the cap drops the least
// recently active folds that are only a cache, so memory follows the chats in use, not every chat
// opened since launch.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import {
  heldStructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWorkHost
} from './structured-agent-session-host-current-work'

export const STRUCTURED_AGENT_SESSION_IDLE_SWEEP_INTERVAL_MS = 5 * 60_000
export const STRUCTURED_AGENT_SESSION_IDLE_MS = 30 * 60_000
/** Resident folds at rest: every chat a person can have on screen, plus the ones they switch
 *  between. Each fold holds its whole epoch, so this, not the tab count, bounds that memory. */
export const STRUCTURED_AGENT_SESSION_MAX_RESIDENT = 24

export type StructuredAgentSessionIdleSweepDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession> & {
    lastActivityAt: (sessionId: string) => number | undefined
    touch: (sessionId: string) => void
  }
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  isDisposed: () => boolean
  deliveryActive: (sessionId: string) => boolean
  /** Includes provider work not yet recorded. */
  childWorkOpen: (sessionId: string) => boolean
  hasOpenDispatch: (sessionId: string) => boolean
  /** Provider-retained, unanswered sends. */
  providerHoldsDispatch: (sessionId: string) => boolean
  store: StructuredAgentSessionCurrentWorkHost['store']
  /** Already inside nonreentrant session serialization. */
  stopAgent: (sessionId: string) => Promise<void>
  stopStartingAgent: (sessionId: string) => Promise<void>
  closeConversation: (sessionId: string) => Promise<boolean>
  logger: StructuredAgentSessionLogger
  intervalMs?: number
  idleMs?: number
  maxResident?: number
}

export type StructuredAgentSessionChildWorkReads = {
  /** Ended-generation turns/prompts cannot retain children; null means no held conversation. */
  currentWork: () => Pick<
    StructuredAgentSessionCurrentWork,
    'activeTurnId' | 'hasActionablePrompt'
  > | null
  /** Provider evidence; bounded stores may have refused a record. */
  childWorkOpen: () => boolean
  hasOpenDispatch: () => boolean
  providerHoldsDispatch: () => boolean
}

/** Check turn, child, dispatch, held-send and prompt work without building a snapshot. */
export function structuredAgentSessionChildHasOpenWork(
  reads: StructuredAgentSessionChildWorkReads
): boolean {
  const work = reads.currentWork()
  return (
    (work !== null && work.activeTurnId() !== null) ||
    reads.childWorkOpen() ||
    reads.hasOpenDispatch() ||
    reads.providerHoldsDispatch() ||
    (work !== null && work.hasActionablePrompt())
  )
}

export class StructuredAgentSessionIdleSweep {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private readonly deps: StructuredAgentSessionIdleSweepDeps) {}

  start(): void {
    this.timer = setInterval(
      () => void this.tick(),
      this.deps.intervalMs ?? STRUCTURED_AGENT_SESSION_IDLE_SWEEP_INTERVAL_MS
    )
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run sessions concurrently; skip overlapping ticks so one locked start cannot delay others. */
  async tick(): Promise<void> {
    if (this.running || this.deps.isDisposed()) {
      return
    }
    this.running = true
    try {
      await Promise.allSettled(
        [...this.deps.sessions.keys()].map((sessionId) =>
          this.deps
            .serialize(sessionId, () => this.tickUnderSerialize(sessionId))
            .catch((error: unknown) =>
              this.deps.logger.warn('an idle sweep step failed', {
                scope: 'idle-sweep',
                sessionId,
                error
              })
            )
        )
      )
    } finally {
      this.running = false
    }
  }

  /** Recheck under serialization to include queued acceptance. */
  private async tickUnderSerialize(sessionId: string): Promise<void> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.deps.isDisposed()) {
      return
    }
    // Renew owed work every tick to allow a full window for the lead’s post-child wake-up.
    if (session.child && session.child.phase !== 'starting' && this.owesWork(sessionId, session)) {
      this.deps.sessions.touch(sessionId)
      return
    }
    const lastActivityAt = this.deps.sessions.lastActivityAt(sessionId) ?? this.deps.now()
    if (this.deps.now() - lastActivityAt < (this.deps.idleMs ?? STRUCTURED_AGENT_SESSION_IDLE_MS)) {
      return
    }
    if (session.child) {
      if (session.child.phase === 'starting') {
        await this.deps.stopStartingAgent(sessionId)
        return
      }
      await this.deps.stopAgent(sessionId)
    }
    await this.deps.closeConversation(sessionId)
  }

  private queuedOrDelivering(sessionId: string, session: StructuredAgentSessionHostSession) {
    return (
      this.deps.deliveryActive(sessionId) ||
      session.journal.submissions().some(isQueuedAgentJournalSubmission)
    )
  }

  /** Without a child, leftover turns/prompts are history and cannot retain the handle. */
  private owesWork(sessionId: string, session: StructuredAgentSessionHostSession): boolean {
    return (
      this.queuedOrDelivering(sessionId, session) ||
      structuredAgentSessionChildHasOpenWork({
        currentWork: () =>
          heldStructuredAgentSessionCurrentWork(
            this.deps.store,
            sessionId,
            session.journal,
            session
          ),
        childWorkOpen: () => this.deps.childWorkOpen(sessionId),
        hasOpenDispatch: () => this.deps.hasOpenDispatch(sessionId),
        providerHoldsDispatch: () => this.deps.providerHoldsDispatch(sessionId)
      })
    )
  }
}
