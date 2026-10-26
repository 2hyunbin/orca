import type { MailLineageScope } from '../../native-chat/agent-session-journal/journal-mail-holds'
import { sessionMailRecipient } from './session-mail-recipient'
import { isOrcaSessionId, ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/orca-session-address'
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

export function structuredSessionDebtAddresses(
  sessionId: string,
  db: OrchestrationDb,
  scope?: MailLineageScope
): string[] {
  const aliases = scope?.aliases ?? [sessionId]
  const addresses = new Set(
    aliases.filter(isOrcaSessionId).map((id) => `${ORCA_SESSION_ADDRESS_PREFIX}${id}`)
  )
  try {
    const recipient = sessionMailRecipient(
      db,
      sessionId,
      [],
      scope ?? { aliases: [sessionId], root: sessionId }
    )
    for (const address of recipient.direct) {
      addresses.add(address)
    }
    for (const run of recipient.runs) {
      addresses.add(`run:${run}`)
    }
  } catch {
    /* Exact recorded-session debt is independent of lineage permission. */
  }
  for (const alias of aliases.filter(isOrcaSessionId)) {
    for (const run of db.runsBoundToCoordinator({
      orcaSessionId: alias,
      terminalHandle: null,
      paneKey: null
    })) {
      addresses.add(`run:${run.id}`)
    }
  }
  const directAddresses = [...addresses]
  for (const address of directAddresses) {
    for (const row of db.db
      .prepare('SELECT id FROM dispatch_contexts WHERE assignee_handle = ?')
      .all(address)) {
      addresses.add(`dispatch:${String(row.id)}`)
    }
  }
  return [...addresses]
}

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

export type SessionMailInterest = {
  db: OrchestrationDb
  inFlight: boolean
  parked: Map<string, { key?: string }>
  pending: Map<string, boolean>
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
  protected readonly interests = new Map<string, SessionMailInterest>()
  constructor(protected readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {}

  resetForDatabaseChange(): void {
    this.interests.clear()
  }
  forgetSession(sessionId: string): void {
    this.interests.delete(sessionId)
  }

  protected currentInterest(sessionId: string, interest: SessionMailInterest): boolean {
    return this.interests.get(sessionId) === interest && this.deps.getDb() === interest.db
  }

  deliverForHandle(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): boolean {
    return this.offer(mailboxHandle, reservedTypes, true)
  }

  protected offer(
    mailboxHandle: string,
    reservedTypes: ReadonlySet<string> | undefined,
    explicit: boolean
  ): boolean {
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    const db = this.deps.getDb()
    if (!target || !db) {
      return false
    }
    let interest = this.interests.get(target.sessionId)
    if (!interest || interest.db !== db) {
      interest = { db, inFlight: false, parked: new Map(), pending: new Map() }
      this.interests.set(target.sessionId, interest)
    }
    if (interest.inFlight) {
      interest.pending.set(mailboxHandle, explicit || interest.pending.get(mailboxHandle) === true)
      return true
    }
    const unchanged =
      !explicit &&
      interest.parked.get(mailboxHandle)?.key ===
        this.admissionKey(db, mailboxHandle, target.sessionId)
    interest.inFlight = true
    void this.deliver(mailboxHandle, target, interest, reservedTypes, unchanged).catch(
      () => undefined
    )
    return true
  }

  onJournalActivity(sessionId: string): void {
    const interest = this.interests.get(sessionId)
    const address = interest?.parked.keys().next().value
    if (!interest || !address || !this.currentInterest(sessionId, interest)) {
      return
    }
    if (interest.inFlight) {
      interest.pending.set(address, interest.pending.get(address) === true)
      return
    }
    this.offer(address, undefined, false)
    if (!interest.inFlight) {
      interest.parked.delete(address)
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

  protected reconcileIssued(
    db: OrchestrationDb,
    sessionId: string,
    read: StructuredMailboxPointerHost['readHandoffEvidenceNow']
  ): ReadonlySet<string> {
    const facts = this.deps.host.readHandoffEvidenceNow({
      sessionId,
      clientMessageId: ''
    })?.mailHold
    const addresses = structuredSessionDebtAddresses(sessionId, db, facts?.scope)
    const excluded = new Set<string>()
    for (const row of db.getIssuedSessionMail(
      [sessionId, ...(facts?.scope?.aliases ?? [])],
      addresses
    )) {
      const reference = readMailHandoff(row.handoff)
      if (reference?.kind !== 'structured') {
        continue
      }
      const replay = reconcileStructuredMailInput(
        this.deps.host,
        db,
        row.to_handle,
        [row],
        reference
      )
      const current = db.getMessageById(row.id)
      if (!replay && reference.phase === 'reserved' && current?.handoff === row.handoff) {
        excluded.add(reference.operationId)
      }
      if (current) {
        selectStructuredMailHandoff({
          db,
          mailbox: row.to_handle,
          sessionId: reference.sessionId,
          epoch: reference.epoch,
          frontier: reference.frontier,
          waiters: undefined,
          reservedTypes: undefined,
          readEvidence: read,
          candidates: [current],
          settlementOnly: true
        })
      }
    }
    return excluded
  }

  protected abstract deliver(
    mailbox: string,
    target: StructuredPointerTarget,
    interest: SessionMailInterest,
    reservedTypes?: ReadonlySet<string>,
    settlementOnly?: boolean
  ): Promise<void>
}
