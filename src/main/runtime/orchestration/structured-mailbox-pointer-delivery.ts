import { isAdmissibleAgentJournalMessageBody } from '../../../shared/agent-session-journal-schemas'
import { selectSessionMail } from './structured-session-mail-target'
import {
  reconcileStructuredMailInput,
  recordStructuredMailHandoff as record
} from './structured-mailbox-pointer-receipt'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { StructuredPointerRetainReason } from './structured-session-pointer-delivery'
import { readMailHandoff } from './mail-handoff'
import { structuredMailMaySubmit, mailTransportWasRefused } from './mailbox-settlement'
import {
  StructuredMailboxPointerAdmission,
  type StructuredPointerTarget
} from './structured-mailbox-pointer-admission'
export type {
  StructuredMailboxPointerHost,
  StructuredPointerSessionFacts,
  StructuredPointerTarget,
  StructuredPointerSendOutcome
} from './structured-mailbox-pointer-admission'

export class OrchestrationStructuredMailboxPointerDelivery<
  TWaiter extends OrchestrationMessageWaiter
> extends StructuredMailboxPointerAdmission<TWaiter> {
  protected override async deliver(
    mailbox: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>,
    settlementOnly = false
  ): Promise<void> {
    const sessionId = target.sessionId
    this.inFlight.add(sessionId)
    this.parkedUntilJournalEdge.set(mailbox, { sessionId: target.sessionId })
    const startingDb = this.deps.getDb()
    if (!startingDb) {
      this.inFlight.delete(sessionId)
      return
    }
    let expectedChanges = this.changes(startingDb)
    const externalVersion = startingDb.db.pragma('data_version', { simple: true })
    const startingKeys = new Map<string, string>()
    const ownWrite = <T>(write: () => T): T => {
      const before = this.changes(startingDb)
      if (before !== expectedChanges) {
        this.changedDuringFlight.add(mailbox)
      }
      try {
        return write()
      } finally {
        expectedChanges += this.changes(startingDb) - before
      }
    }
    const park = (address: string) => {
      if (!startingKeys.has(address)) {
        startingKeys.set(address, this.admissionKey(startingDb, address, sessionId))
      }
      this.parkedUntilJournalEdge.set(address, { sessionId })
    }
    park(mailbox)
    const transientExclusions = Boolean(reservedTypes?.size)
    try {
      await this.reconcileIssued(startingDb, sessionId, settlementOnly, ownWrite)
      if (settlementOnly) {
        return
      }
      const reconciled = new Set<string>()
      const replanned = new Set<string>()
      for (;;) {
        const db = this.deps.getDb()
        if (!db || db !== startingDb) {
          return
        }
        const session = await this.deps.host.readSessionFacts(target.sessionId)
        const fence = this.deps.host.currentFence(target.sessionId)
        if (!session || fence === null) {
          this.retain(mailbox, target.sessionId, 'session-not-attached')
          return
        }
        const chosen = await selectSessionMail({
          ...this.deps,
          db,
          mailbox,
          target,
          session,
          fence,
          reservedTypes,
          reconciled,
          park,
          ownWrite,
          onIssued: (message, address) =>
            this.issued.set(message.id, { db, mailbox: address, sessionId }),
          forget: (address) => {
            this.parkedUntilJournalEdge.delete(address)
          }
        })
        if (!chosen) {
          return
        }
        mailbox = chosen.address
        target = chosen.target
        const batch = chosen.batch
        let { messages, reference } = batch
        const manifest = reference.manifest
        if (
          !manifest ||
          (!reference.nonAdmission &&
            !ownWrite(() =>
              reconcileStructuredMailInput(this.deps.host, db, mailbox, messages, reference)
            ))
        ) {
          reconciled.add(reference.operationId)
          continue
        }
        const current = (): boolean => {
          const next = this.deps.resolveStructuredTarget(mailbox)
          return (
            next?.sessionId === target.sessionId &&
            next.dispatchId === target.dispatchId &&
            this.deps.host.currentContextClearOperationId(target.sessionId) === manifest.context &&
            this.deps.host.currentFence(target.sessionId) === manifest.runtimeFence &&
            manifest.members.length === messages.length &&
            manifest.members.every((id, index) => messages[index]?.id === id) &&
            db.isMailHandoffCurrent(mailbox, messages, reference.authority) &&
            messages.every((message) => {
              const reserved = readMailHandoff(message.handoff)
              return (
                reserved?.kind === 'structured' &&
                structuredMailMaySubmit(
                  reserved,
                  this.deps.host.readHandoffEvidenceNow,
                  manifest.members
                )
              )
            })
          )
        }
        if (!current()) {
          if (reference.nonAdmission && !replanned.has(reference.operationId)) {
            replanned.add(reference.operationId)
            ownWrite(() =>
              record(db, mailbox, messages, (member) => ({ ...member, nonAdmission: 'held' }))
            )
          } else {
            reconciled.add(reference.operationId)
          }
          continue
        }
        park(mailbox)
        if (this.deps.host.takesMailNow?.(sessionId) === false) {
          return
        }
        const body: unknown = JSON.parse(manifest.body)
        if (!isAdmissibleAgentJournalMessageBody(body)) {
          return
        }
        const neverAdmitted = Boolean(reference.nonAdmission)
        ownWrite(() =>
          record(db, mailbox, messages, ({ nonAdmission: _result, ...member }) => member)
        )
        messages = messages
          .map((message) => db.getMessageById(message.id))
          .filter((message) => message !== undefined)
        const attempt = readMailHandoff(messages[0]?.handoff)
        if (attempt?.kind !== 'structured') {
          return
        }
        reference = attempt
        park(mailbox)
        for (const message of messages) {
          this.issued.set(message.id, { db, mailbox, sessionId })
        }
        const outcome = await this.deps.host.send({
          sessionId: target.sessionId,
          dispatchId: target.dispatchId,
          operationId: reference.operationId,
          expectedRuntimeFence: manifest.runtimeFence,
          body,
          beforeRun: current
        })
        if (outcome.kind === 'held') {
          ownWrite(() =>
            record(db, mailbox, messages, (member) => ({ ...member, nonAdmission: 'held' }))
          )
          park(mailbox)
          this.retain(mailbox, target.sessionId, 'turn-unsettled')
          if (
            this.deps.host.takesMailNow?.(sessionId) === true &&
            !replanned.has(reference.operationId)
          ) {
            replanned.add(reference.operationId)
            continue
          }
          return
        }
        if (outcome.kind === 'unattached') {
          this.retain(mailbox, target.sessionId, 'session-not-attached')
          return
        }
        if (outcome.kind === 'superseded') {
          if (!outcome.noEffect || replanned.has(reference.operationId)) {
            reconciled.add(reference.operationId)
          }
          if (outcome.noEffect) {
            ownWrite(() =>
              record(db, mailbox, messages, (member) => ({ ...member, nonAdmission: 'held' }))
            )
            replanned.add(reference.operationId)
          }
          continue
        }
        if (outcome.kind === 'sent' && outcome.state !== 'accepted') {
          const nonAdmission =
            outcome.nonAdmission === 'expired' && !neverAdmitted ? undefined : outcome.nonAdmission
          if (nonAdmission === 'expired') {
            this.changedDuringFlight.add(mailbox)
          }
          const evidence = this.deps.host.readHandoffEvidenceNow(reference)
          if (nonAdmission || (evidence && mailTransportWasRefused(evidence))) {
            ownWrite(() =>
              record(db, mailbox, messages, (member) => ({
                ...member,
                nonAdmission: nonAdmission ?? 'refused'
              }))
            )
          }
          this.retain(
            mailbox,
            target.sessionId,
            outcome.state === 'rejected' ? 'dispatch-rejected' : 'turn-unsettled'
          )
          return
        }
        ownWrite(() =>
          record(db, mailbox, messages, (member) => ({
            ...member,
            phase: 'offered',
            clientMessageId: outcome.clientMessageId ?? reference.clientMessageId
          }))
        )
        reservedTypes = undefined
        const next = this.deps.resolveStructuredTarget(mailbox)
        if (!next || next.sessionId !== target.sessionId) {
          return
        }
        target = next
      }
    } finally {
      this.inFlight.delete(sessionId)
      const changed =
        this.deps.getDb() !== startingDb ||
        this.changes(startingDb) !== expectedChanges ||
        startingDb.db.pragma('data_version', { simple: true }) !== externalVersion
      for (const [address, key] of startingKeys) {
        if (this.deps.getDb() !== startingDb) {
          this.parkedUntilJournalEdge.delete(address)
          this.changedDuringFlight.add(address)
          continue
        }
        const finalKey = this.admissionKey(startingDb, address, sessionId)
        const before: unknown[] = JSON.parse(key)
        const after: unknown[] = JSON.parse(finalKey)
        before[1] = expectedChanges
        if (transientExclusions || changed || JSON.stringify(before) !== JSON.stringify(after)) {
          this.changedDuringFlight.add(address)
        } else {
          this.parkedUntilJournalEdge.set(address, { sessionId, db: startingDb, key: finalKey })
        }
      }
      for (const address of this.changedDuringFlight) {
        if (this.deps.resolveStructuredTarget(address)?.sessionId === sessionId) {
          this.changedDuringFlight.delete(address)
          const explicit = this.explicitDuringFlight.delete(address)
          queueMicrotask(() => this.offer(address, undefined, explicit))
        }
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
