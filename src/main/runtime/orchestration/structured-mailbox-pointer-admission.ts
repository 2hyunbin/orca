import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { CommandReceiptRead } from '../../native-chat/agent-session-journal/command-receipt-table'
import type { OrchestrationDb } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { SenderNameResolver } from './agent-message-sender'
import type {
  StructuredDispatchState,
  StructuredPointerRetainReason
} from './structured-session-pointer-delivery'
import { readMailHandoff, type StructuredMailHandoff } from './mail-handoff'
import { selectStructuredMailHandoff } from './mailbox-settlement'
import { reconcileStructuredMailInput } from './structured-mailbox-pointer-receipt'
import type { StructuredMailEvidence } from './mailbox-settlement'

export type StructuredPointerTarget = { sessionId: string; dispatchId: string | null }
export type StructuredPointerSendOutcome =
  | {
      kind: 'sent'
      state: StructuredDispatchState
      clientMessageId?: string
      nonAdmission?: 'refused' | 'expired'
    }
  | { kind: 'held' }
  | { kind: 'superseded'; noEffect?: boolean }
  /** The chat's queue took it, as it takes a person's message. */
  | { kind: 'queued'; clientMessageId?: string }
  | { kind: 'unattached' }

export type StructuredPointerSessionFacts = Pick<
  StructuredMailEvidence,
  'epoch' | 'frontier' | 'mailHold'
>
type MailEvidenceSource = Pick<StructuredMailHandoff, 'sessionId' | 'clientMessageId'>

export type StructuredMailboxPointerHost = {
  readReceipt?: (reference: StructuredMailHandoff) => CommandReceiptRead
  readSessionFacts: (sessionId: string) => Promise<StructuredPointerSessionFacts | null>
  readHandoffEvidence: (reference: MailEvidenceSource) => Promise<StructuredMailEvidence | null>
  readHandoffEvidenceNow: (reference: MailEvidenceSource) => StructuredMailEvidence | null
  takesMailNow?: (sessionId: string) => boolean | null
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

type ParkedDelivery = {
  sessionId: string
  key?: string
  db?: OrchestrationDb
}
type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getWaiterRevision?: (mailboxHandle: string) => number
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

export abstract class StructuredMailboxPointerAdmission<
  TWaiter extends OrchestrationMessageWaiter
> {
  protected readonly inFlight = new Set<string>()
  protected readonly parkedUntilJournalEdge = new Map<string, ParkedDelivery>()
  protected readonly issued = new Map<
    string,
    { db: OrchestrationDb; mailbox: string; sessionId: string }
  >()
  protected readonly explicitDuringFlight = new Set<string>()
  protected readonly changedDuringFlight = new Set<string>()

  constructor(protected readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): boolean {
    return this.offer(mailboxHandle, reservedTypes, true)
  }

  protected offer(
    mailboxHandle: string,
    reservedTypes: ReadonlySet<string> | undefined,
    explicit: boolean
  ): boolean {
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    if (!target) {
      return false
    }
    if (this.inFlight.has(target.sessionId)) {
      if (explicit) {
        this.changedDuringFlight.add(mailboxHandle)
        this.explicitDuringFlight.add(mailboxHandle)
      }
      return true
    }
    const parked = this.parkedUntilJournalEdge.get(mailboxHandle)
    const db = this.deps.getDb()
    const unchanged =
      !explicit &&
      db &&
      parked?.db === db &&
      parked.key === this.admissionKey(db, mailboxHandle, target.sessionId)
    if (
      unchanged &&
      ![...this.issued.values()].some(
        (debt) => debt.sessionId === target.sessionId && debt.db === db
      )
    ) {
      return true
    }
    void this.deliver(mailboxHandle, target, reservedTypes, Boolean(unchanged)).catch(
      () => undefined
    )
    return true
  }

  onJournalActivity(sessionId: string): void {
    const entry = [...this.parkedUntilJournalEdge].find(
      ([, parked]) => parked.sessionId === sessionId
    )
    if (entry) {
      this.offer(entry[0], undefined, false)
    }
  }

  protected admissionKey(db: OrchestrationDb, mailbox: string, sessionId: string): string {
    const evidence = this.deps.host.readHandoffEvidenceNow({ sessionId, clientMessageId: '' })
    const waiters = this.deps.getMessageWaiters(mailbox)
    return JSON.stringify([
      db.db.pragma('data_version', { simple: true }),
      this.changes(db),
      evidence?.epoch,
      evidence?.frontier,
      evidence?.mailHold?.key,
      this.deps.host.takesMailNow?.(sessionId),
      this.deps.host.hasActionablePromptNow(sessionId),
      this.deps.host.currentFence(sessionId),
      this.deps.host.currentContextClearOperationId(sessionId),
      this.deps.getWaiterRevision?.(mailbox),
      [...(waiters ?? [])].map((waiter) => waiter.typeFilter)
    ])
  }

  protected changes(db: OrchestrationDb): number {
    return Number(db.db.prepare('SELECT total_changes() AS n').get()?.n)
  }

  forgetSession(sessionId: string): void {
    for (const [id, debt] of this.issued) {
      if (debt.sessionId === sessionId) {
        this.issued.delete(id)
      }
    }
    for (const [mailbox, parked] of this.parkedUntilJournalEdge) {
      if (parked.sessionId === sessionId) {
        this.parkedUntilJournalEdge.delete(mailbox)
      }
    }
  }

  protected async reconcileIssued(
    startingDb: OrchestrationDb,
    sessionId: string,
    settlementOnly: boolean,
    ownWrite: <T>(write: () => T) => T
  ): Promise<void> {
    if (!settlementOnly) {
      for (const row of startingDb.db
        .prepare(
          'SELECT id, to_handle, handoff FROM messages WHERE read = 0 AND handoff IS NOT NULL'
        )
        .all()) {
        const reference = readMailHandoff(String(row.handoff))
        if (
          reference?.kind === 'structured' &&
          (reference.sessionId === sessionId ||
            this.deps.resolveStructuredTarget(String(row.to_handle))?.sessionId === sessionId) &&
          !reference.nonAdmission
        ) {
          this.issued.set(String(row.id), {
            db: startingDb,
            mailbox: String(row.to_handle),
            sessionId
          })
        }
      }
    }
    for (const [id, debt] of this.issued) {
      if (debt.sessionId !== sessionId || debt.db !== startingDb) {
        continue
      }
      const row = startingDb.getMessageById(id)
      const reference = readMailHandoff(row?.handoff)
      if (
        !row ||
        row.read ||
        row.to_handle !== debt.mailbox ||
        reference?.kind !== 'structured' ||
        reference.nonAdmission
      ) {
        this.issued.delete(id)
        continue
      }
      ownWrite(() =>
        reconcileStructuredMailInput(this.deps.host, startingDb, debt.mailbox, [row], reference)
      )
      const current = startingDb.getMessageById(id)
      if (current) {
        await selectStructuredMailHandoff({
          db: startingDb,
          mailbox: debt.mailbox,
          sessionId: reference.sessionId,
          epoch: reference.epoch,
          frontier: reference.frontier,
          waiters: undefined,
          reservedTypes: undefined,
          readEvidence: (r) => this.deps.host.readHandoffEvidence(r),
          candidates: [current],
          settlementOnly: true,
          ownWrite
        })
      }
      if (startingDb.getMessageById(id)?.read) {
        this.issued.delete(id)
      }
    }
  }

  protected abstract deliver(
    mailbox: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>,
    settlementOnly?: boolean
  ): Promise<void>
}
