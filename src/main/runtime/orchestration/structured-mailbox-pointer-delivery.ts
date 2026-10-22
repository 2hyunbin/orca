import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import type { OrchestrationCliCommand } from './cli-command'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import { structuredMailSource } from './structured-mail-source'
import type { SenderNameResolver } from './agent-message-sender'
import type {
  StructuredDispatchState,
  StructuredPointerRetainReason
} from './structured-session-pointer-delivery'
import { readMailHandoff, type StructuredMailHandoff } from './mail-handoff'
import { drainLegacyMailHandoff } from './legacy-mail-handoff'
import {
  mailHandoffWasCut,
  mailTransportWasRefused,
  selectStructuredMailHandoff,
  type StructuredMailEvidence
} from './mailbox-settlement'

export type StructuredPointerTarget = { sessionId: string; dispatchId: string | null }
export type StructuredPointerSendOutcome =
  | {
      kind: 'sent'
      state: StructuredDispatchState
      clientMessageId?: string
      nonAdmission?: 'refused' | 'expired'
    }
  | { kind: 'held' | 'superseded' | 'unattached' }
  | { kind: 'queued'; clientMessageId?: string }

export type StructuredPointerSessionFacts = {
  epoch: string
  frontier: string
}

export type StructuredMailboxPointerHost = {
  readSessionFacts: (sessionId: string) => Promise<StructuredPointerSessionFacts | null>
  readHandoffEvidence: (reference: StructuredMailHandoff) => Promise<StructuredMailEvidence | null>
  readHandoffEvidenceNow: (reference: StructuredMailHandoff) => StructuredMailEvidence | null
  hasActionablePromptNow: (sessionId: string) => boolean | null
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    body: AgentJournalMessageItem
    beforeRun: () => boolean
  }) => Promise<StructuredPointerSendOutcome>
  currentFence: (sessionId: string) => number | null
  currentContextClearOperationId: (sessionId: string) => string | undefined
}

type ParkedDelivery = { sessionId: string; reservedTypes: ReadonlySet<string> | undefined }
type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
  getCliCommand: () => OrchestrationCliCommand
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
  private readonly parkedUntilJournalEdge = new Map<string, ParkedDelivery>()
  private readonly changedDuringFlight = new Set<string>()

  constructor(private readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(mailbox: string, reservedTypes?: ReadonlySet<string>): boolean {
    const target = this.deps.resolveStructuredTarget(mailbox)
    if (!target) {
      return false
    }
    if (this.inFlight.has(mailbox)) {
      this.changedDuringFlight.add(mailbox)
      return true
    }
    void this.deliver(mailbox, target, reservedTypes).catch(() => undefined)
    return true
  }

  onJournalActivity(sessionId: string): void {
    for (const [mailbox, parked] of this.parkedUntilJournalEdge) {
      if (parked.sessionId === sessionId) {
        this.deliverForHandle(mailbox, parked.reservedTypes)
      }
    }
  }

  forgetSession(sessionId: string): void {
    for (const [mailbox, parked] of this.parkedUntilJournalEdge) {
      if (parked.sessionId === sessionId) {
        this.parkedUntilJournalEdge.delete(mailbox)
      }
    }
  }

  private async deliver(
    mailbox: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>
  ): Promise<void> {
    this.inFlight.add(mailbox)
    this.parkedUntilJournalEdge.set(mailbox, { sessionId: target.sessionId, reservedTypes })
    try {
      for (;;) {
        const db = this.deps.getDb()
        if (!db) {
          return
        }
        const session = await this.deps.host.readSessionFacts(target.sessionId)
        const fence = this.deps.host.currentFence(target.sessionId)
        if (!session || fence === null) {
          this.retain(mailbox, target.sessionId, 'session-not-attached')
          return
        }
        const legacy = db.getStructuredPointerOperation(mailbox)
        if (legacy?.session_id === target.sessionId) {
          const evidence = await this.deps.host.readHandoffEvidence({
            version: 1,
            kind: 'structured',
            sessionId: target.sessionId,
            epoch: session.epoch,
            frontier: session.frontier,
            operationId: legacy.operation_id,
            authorizationId: legacy.operation_id,
            clientMessageId: legacy.operation_id,
            phase: 'reserved',
            authority: db.mailboxHandoffAuthority(mailbox)
          })
          if (evidence) {
            drainLegacyMailHandoff(db, legacy, evidence)
          }
        }
        const batch = await selectStructuredMailHandoff({
          db,
          mailbox,
          sessionId: target.sessionId,
          epoch: session.epoch,
          frontier: session.frontier,
          waiters: this.deps.getMessageWaiters(mailbox),
          reservedTypes,
          readEvidence: (reference) => this.deps.host.readHandoffEvidence(reference)
        })
        if (!batch) {
          if (
            !db.getAutomaticMailCandidates(mailbox, {
              afterSequence: 0,
              excludeTypes: [],
              limit: 1
            }).length
          ) {
            this.parkedUntilJournalEdge.delete(mailbox)
          }
          return
        }
        const { messages, reference } = batch
        const context = this.deps.host.currentContextClearOperationId(target.sessionId)
        const current = (): boolean => {
          const next = this.deps.resolveStructuredTarget(mailbox)
          return (
            next?.sessionId === target.sessionId &&
            next.dispatchId === target.dispatchId &&
            this.deps.host.currentContextClearOperationId(target.sessionId) === context &&
            db.isMailHandoffCurrent(mailbox, messages, reference.authority) &&
            messages.every((message) => {
              const reserved = readMailHandoff(message.handoff)
              if (reserved?.kind !== 'structured') {
                return false
              }
              const now = this.deps.host.readHandoffEvidenceNow(reserved)
              if (
                !now ||
                now.epoch !== reserved.epoch ||
                (message.recovery_used && now.stopInForce)
              ) {
                return false
              }
              if (!reserved.recoverySource) {
                return true
              }
              const source = { ...reserved, clientMessageId: reserved.recoverySource }
              const evidence = this.deps.host.readHandoffEvidenceNow(source)
              return evidence !== null && mailHandoffWasCut(source, evidence)
            })
          )
        }
        if (!current()) {
          return
        }
        const body: AgentJournalMessageItem = {
          kind: 'message',
          role: 'user',
          blocks: [
            {
              type: 'text',
              text: formatMessagePointer(messages.length, mailbox, this.deps.getCliCommand()).trim()
            }
          ],
          from: structuredMailSource({
            db,
            mailboxHandle: mailbox,
            dispatchId: target.dispatchId,
            batch: messages,
            senderName: this.deps.senderName
          })
        }
        const outcome = await this.deps.host.send({
          sessionId: target.sessionId,
          dispatchId: target.dispatchId,
          operationId: reference.operationId,
          expectedRuntimeFence: fence,
          body,
          beforeRun: current
        })
        if (outcome.kind === 'held') {
          this.retain(mailbox, target.sessionId, 'turn-unsettled')
          return
        }
        if (outcome.kind === 'unattached') {
          this.retain(mailbox, target.sessionId, 'session-not-attached')
          return
        }
        if (outcome.kind === 'superseded') {
          return
        }
        if (outcome.kind === 'sent' && outcome.state !== 'accepted') {
          if (outcome.nonAdmission === 'expired') {
            this.changedDuringFlight.add(mailbox)
          }
          const evidence = this.deps.host.readHandoffEvidenceNow(reference)
          if (outcome.nonAdmission || (evidence && mailTransportWasRefused(evidence))) {
            for (const message of messages) {
              const member = readMailHandoff(message.handoff)
              if (member?.kind === 'structured') {
                db.recordMailHandoff(mailbox, [message], {
                  ...member,
                  nonAdmission: outcome.nonAdmission ?? 'refused'
                })
              }
            }
          }
          this.retain(
            mailbox,
            target.sessionId,
            outcome.state === 'rejected' ? 'dispatch-rejected' : 'turn-unsettled'
          )
          return
        }
        for (const message of messages) {
          const member = readMailHandoff(message.handoff)
          if (member?.kind === 'structured') {
            db.recordMailHandoff(mailbox, [message], {
              ...member,
              phase: 'offered',
              clientMessageId: outcome.clientMessageId ?? reference.clientMessageId
            })
          }
        }
        reservedTypes = undefined
        const next = this.deps.resolveStructuredTarget(mailbox)
        if (!next || next.sessionId !== target.sessionId) {
          return
        }
        target = next
      }
    } finally {
      this.inFlight.delete(mailbox)
      if (this.changedDuringFlight.delete(mailbox)) {
        queueMicrotask(() => this.deliverForHandle(mailbox, reservedTypes))
      }
    }
  }

  private retain(
    mailboxHandle: string,
    sessionId: string,
    reason: StructuredPointerRetainReason
  ): void {
    this.deps.onRetain?.({ mailboxHandle, sessionId, reason })
  }
}
