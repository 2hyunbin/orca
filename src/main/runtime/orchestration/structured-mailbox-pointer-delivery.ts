/**
 * The mail lane for agents that ARE a structured agent session: each orchestration message is
 * sent to the chat whole, as its own message, when it arrives.
 *
 * The PTY lane types a "you have mail, run `check`" pointer into a live pane, because typing the
 * mail itself there collided with a person's half-typed text. A chat has no shared input box: the
 * message goes through the chat's own send, as a person's message does, and the retry edge is the
 * journal. So this is a sibling of `OrchestrationMailboxPointerDelivery` rather than a branch
 * inside it; only batch selection is shared.
 *
 * Coordinators are in scope here, unlike the PTY lane's reasoning: a PTY coordinator blocks in
 * `check --wait`, where a waiter preempts delivery, but a structured coordinator is a chat session
 * whose turn ends — so nothing else would ever prompt it for its own `run:` mail.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { MessageRow, OrchestrationDb } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import {
  resolveStructuredMailOperation,
  type StructuredMailOperation,
  type StructuredMailSubmission
} from './structured-pointer-operation-id'
import { structuredMailBody } from './structured-mail-source'
import type { SenderNameResolver } from './agent-message-sender'
import {
  retainReasonForDispatch,
  structuredDispatchDelivered,
  type StructuredDispatchState,
  type StructuredPointerRetainReason
} from './structured-session-pointer-delivery'

export type StructuredPointerTarget = {
  sessionId: string
  /**
   * The dispatch whose mailbox this is, or null for direct peer mail addressed to the worker's own
   * handle outside any dispatch. Nothing downstream needs a dispatch to deliver — it only names
   * the caller on the operation row and the mail's source — so a worker between dispatches is
   * nudged, not dropped.
   */
  dispatchId: string | null
}

type ParkedPointerDelivery = {
  sessionId: string
  reservedTypes: ReadonlySet<string> | undefined
}

export type StructuredPointerSendOutcome =
  | { kind: 'sent'; state: StructuredDispatchState }
  /** The chat's queue took it, as it takes a person's message. */
  | { kind: 'queued' }
  | { kind: 'unattached' }

export type StructuredPointerSessionFacts = {
  /** Current-context sends, oldest first: what the lane's own sends settled as. */
  submissions: readonly StructuredMailSubmission[]
}

export type StructuredMailboxPointerHost = {
  /** `null` when the session cannot be read. */
  readSessionFacts: (sessionId: string) => Promise<StructuredPointerSessionFacts | null>
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    /** Names its senders as `from`. */
    body: AgentJournalMessageItem
    /** The host answered; the send may still be waiting for the agent to take it in. */
    onAnswered?: () => void
  }) => Promise<StructuredPointerSendOutcome>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
  currentContextClearOperationId: (sessionId: string) => string | undefined
}

type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  /**
   * The session a mailbox must be nudged through, or null when a live PTY can take the bytes.
   *
   * The mailbox is a `dispatch:` address or the worker's own bearer handle; the second is how
   * agents mail each other outside a dispatch, and no other lane can serve it.
   */
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
  /** The CLI name the PTY lane types for a local agent, so both lanes name the same command. */
  getCliCommand: () => OrchestrationCliCommand
  /** What Orca calls a sender now, snapshotted onto the message; null when it has no name. */
  senderName: SenderNameResolver
  host: StructuredMailboxPointerHost
  onRetain?: (input: {
    mailboxHandle: string
    sessionId: string
    reason: StructuredPointerRetainReason
  }) => void
}

export class OrchestrationStructuredMailboxPointerDelivery<
  TWaiter extends OrchestrationMessageWaiter
> {
  private readonly inFlight = new Set<string>()
  /**
   * Mailboxes whose retry must wait for the session's next journal edge, each remembering the
   * session it is parked ON.
   *
   * Recorded rather than re-resolved: `resolveStructuredTarget` answers null whenever the runtime
   * cannot look — a momentarily null DB reference, a session mid-teardown — and pruning on that
   * absence dropped every OTHER worker's parked entry too, silently costing them their wake-up
   * edge until the next explicit check.
   */
  private readonly parkedUntilJournalEdge = new Map<string, ParkedPointerDelivery>()
  /** Messages whose send is still waiting on its outcome, by `mintedOperations` key. */
  private readonly sendsInFlight = new Set<string>()
  /** Mail that arrived while its mailbox's pass ran; the pass runs once more for it. */
  private readonly redeliver = new Map<string, ReadonlySet<string>>()
  /**
   * The id this process minted per message and session context, until the message is received
   * (one a `check` reads instead stays until exit). A journal send under any other id outlived the
   * process that minted it. A fact, not a clock reading, so no clock step can fake it.
   */
  private readonly mintedOperations = new Map<string, StructuredMailOperation>()

  constructor(private readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): boolean {
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    if (!target) {
      return false
    }
    void this.deliver(mailboxHandle, target, reservedTypes).catch(() => {
      // Durable mail stays available to an explicit check or the next settle edge.
    })
    return true
  }

  /** The session's journal moved — a turn settled, or a re-attach replayed it; retry what is
   *  parked on that edge. */
  onJournalActivity(sessionId: string): void {
    for (const [mailboxHandle, parked] of Array.from(this.parkedUntilJournalEdge)) {
      if (parked.sessionId !== sessionId) {
        continue
      }
      this.parkedUntilJournalEdge.delete(mailboxHandle)
      const target = this.deps.resolveStructuredTarget(mailboxHandle)
      if (target?.sessionId !== sessionId) {
        // The mailbox moved off this session (or cannot be resolved right now); its own edge or an
        // explicit check is what retries it, not this session's journal.
        continue
      }
      void this.deliver(mailboxHandle, target, parked.reservedTypes).catch(() => undefined)
    }
  }

  /**
   * The worker settled; drop what IT had parked, and nothing else.
   *
   * The recorded session id is the whole test. Settlement forgets the worker's identity, so
   * re-resolving the target here would answer null for exactly the entries this is meant to
   * prune — and null for every sibling the runtime momentarily cannot resolve either.
   */
  forgetSession(sessionId: string): void {
    for (const [mailboxHandle, parked] of Array.from(this.parkedUntilJournalEdge)) {
      if (parked.sessionId === sessionId) {
        this.parkedUntilJournalEdge.delete(mailboxHandle)
      }
    }
  }

  private async deliver(
    mailboxHandle: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>,
    attemptedContexts = new Set<string>()
  ): Promise<void> {
    const db = this.deps.getDb()
    if (!db) {
      return
    }
    if (this.inFlight.has(mailboxHandle)) {
      const pending = this.redeliver.get(mailboxHandle) ?? []
      this.redeliver.set(mailboxHandle, new Set([...pending, ...(reservedTypes ?? [])]))
      return
    }
    // What an unacknowledged `check` batch holds, its reader already has; sending it too would
    // show it twice, and the rest of the mailbox must not wait for that batch's ack.
    const unread = selectOrchestrationPointerBatch({
      db,
      mailboxHandle,
      waiters: this.deps.getMessageWaiters(mailboxHandle),
      reservedTypes,
      excludeOutstandingDelivery: true
    })
    if (unread.length === 0) {
      return
    }
    this.inFlight.add(mailboxHandle)
    let contextKey: string | undefined
    try {
      const session = await this.deps.host.readSessionFacts(target.sessionId)
      const contextClearOperationId = this.deps.host.currentContextClearOperationId(
        target.sessionId
      )
      contextKey = JSON.stringify([target.sessionId, contextClearOperationId])
      if (attemptedContexts.has(contextKey)) {
        return
      }
      attemptedContexts.add(contextKey)
      await this.attempt(
        db,
        mailboxHandle,
        target,
        unread,
        reservedTypes,
        session,
        contextClearOperationId
      )
    } finally {
      this.inFlight.delete(mailboxHandle)
      // A thrown attempt follows too; its own failure is what still propagates.
      if (contextKey !== undefined) {
        await this.followChangedContext(
          mailboxHandle,
          target,
          reservedTypes,
          attemptedContexts
        ).catch(() => undefined)
      }
      await this.followArrivedMail(mailboxHandle).catch(() => undefined)
    }
  }

  private async followArrivedMail(mailboxHandle: string): Promise<void> {
    const reservedTypes = this.redeliver.get(mailboxHandle)
    const current = reservedTypes && this.deps.resolveStructuredTarget(mailboxHandle)
    this.redeliver.delete(mailboxHandle)
    if (current) {
      await this.deliver(mailboxHandle, current, reservedTypes)
    }
  }

  /** Clear's idle edge can land during a send; retry only a changed context, once per context. */
  private async followChangedContext(
    mailboxHandle: string,
    attempted: StructuredPointerTarget,
    reservedTypes: ReadonlySet<string> | undefined,
    attemptedContexts: Set<string>
  ): Promise<void> {
    const current = this.deps.resolveStructuredTarget(mailboxHandle)
    if (
      !current ||
      attemptedContexts.has(
        JSON.stringify([
          current.sessionId,
          this.deps.host.currentContextClearOperationId(current.sessionId)
        ])
      )
    ) {
      return
    }
    if (this.parkedUntilJournalEdge.get(mailboxHandle)?.sessionId === attempted.sessionId) {
      this.parkedUntilJournalEdge.delete(mailboxHandle)
    }
    await this.deliver(mailboxHandle, current, reservedTypes, attemptedContexts)
  }

  // A session whose agent is not running needs nothing first: an accepted send starts it.
  private async attempt(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    unread: readonly MessageRow[],
    reservedTypes: ReadonlySet<string> | undefined,
    session: StructuredPointerSessionFacts | null,
    contextClearOperationId: string | undefined
  ): Promise<void> {
    const sessionId = target.sessionId
    const fence = session ? this.deps.host.currentFence(sessionId) : null
    if (!session || fence === null) {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return
    }
    // Oldest first, each its own send. The next is issued once the host has answered this one,
    // never after the agent takes it in; one held in doubt does not hold back the ones after it.
    for (const message of unread) {
      if (message.type === 'heartbeat') {
        // Already reconciled when sent; sending each beat would interrupt the chat every time.
        markReceived(db, message.id)
        continue
      }
      const key = JSON.stringify([sessionId, contextClearOperationId ?? null, message.id])
      if (this.sendsInFlight.has(key)) {
        continue
      }
      let answered = (): void => undefined
      const issued = new Promise<true>((resolve) => {
        answered = () => resolve(true)
      })
      const retain = (reason: StructuredPointerRetainReason) =>
        this.retain(mailboxHandle, sessionId, reason, reservedTypes)
      this.sendsInFlight.add(key)
      const outcome = this.sendMessage(db, mailboxHandle, target, message, {
        key,
        session,
        fence,
        retain,
        answered
      }).finally(() => this.sendsInFlight.delete(key))
      // What settles after this pass is its own: nothing awaits it once issued.
      outcome.catch(() => undefined)
      if (!(await Promise.race([issued, outcome]))) {
        return
      }
    }
  }

  /** Sends one message, or replays its send; false when the session cannot take any. */
  private async sendMessage(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    message: MessageRow,
    attempt: {
      key: string
      session: StructuredPointerSessionFacts
      fence: number
      retain: (reason: StructuredPointerRetainReason) => void
      answered: () => void
    }
  ): Promise<boolean> {
    const resolved = resolveStructuredMailOperation({
      messageId: message.id,
      submissions: attempt.session.submissions,
      mintedByThisProcess: this.mintedOperations.get(attempt.key)
    })
    if (resolved.kind === 'park') {
      attempt.retain('turn-unsettled')
      return true
    }
    if (resolved.kind === 'send') {
      this.mintedOperations.set(attempt.key, resolved.operation)
      const outcome = await this.deps.host.send({
        sessionId: target.sessionId,
        dispatchId: target.dispatchId,
        operationId: resolved.operation.operationId,
        expectedRuntimeFence: attempt.fence,
        body: structuredMailBody({
          db,
          mailboxHandle,
          dispatchId: target.dispatchId,
          message,
          senderName: this.deps.senderName,
          cliCommand: this.deps.getCliCommand()
        }),
        onAnswered: attempt.answered
      })
      if (outcome.kind === 'unattached') {
        attempt.retain('session-not-attached')
        return false
      }
      // A queued message is the chat's queue's to send, as a person's queued message is.
      if (outcome.kind === 'sent' && !structuredDispatchDelivered(outcome.state)) {
        // Resending under its id replays this verdict and starts nothing.
        attempt.retain(retainReasonForDispatch(outcome.state))
        return true
      }
    }
    // Sent, queued, or a send this lane gave up waiting on that ran after all.
    markReceived(db, message.id)
    this.mintedOperations.delete(attempt.key)
    return true
  }

  /**
   * No `markAsUndelivered` is owed: a message is marked received only after an accepted dispatch,
   * or once the chat's queue holds it.
   *
   * Every reason parks for the session's next journal edge. `unknown` may mean the message already
   * sits in the provider's input queue, so an immediate retry can stack duplicates;
   * `session-not-attached` and `dispatch-rejected` park because nothing else notices the re-attach
   * or the moved lease, and the dispatch preamble tells workers not to poll.
   */
  private retain(
    mailboxHandle: string,
    sessionId: string,
    reason: StructuredPointerRetainReason,
    reservedTypes: ReadonlySet<string> | undefined
  ): void {
    this.deps.onRetain?.({ mailboxHandle, sessionId, reason })
    this.parkedUntilJournalEdge.set(mailboxHandle, { sessionId, reservedTypes })
  }
}

/** The chat has it, so `check` must not hand it out again. */
function markReceived(db: OrchestrationDb, messageId: string): void {
  db.markAsRead([messageId])
  db.markAsDelivered([messageId])
}
