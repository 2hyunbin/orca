import { isAdmissibleAgentJournalMessageBody } from '../../../shared/agent-session-journal-schemas'
import { selectSessionMail } from './structured-session-mail-target'
import {
  currentSessionMail,
  recordStructuredMailHandoff as record
} from './structured-mailbox-pointer-receipt'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { StructuredPointerRetainReason } from './structured-session-pointer-delivery'
import { readMailHandoff } from './mail-handoff'
import { mailTransportWasRefused } from './mailbox-settlement'
import {
  StructuredMailboxPointerAdmission,
  type SessionMailInterest,
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
    interest: SessionMailInterest,
    reservedTypes?: ReadonlySet<string>,
    settlementOnly = false
  ): Promise<void> {
    const sessionId = target.sessionId
    const startingDb = interest.db
    const active = () => this.currentInterest(sessionId, interest)
    interest.parked.set(mailbox, {})
    let expectedChanges = this.changes(startingDb)
    const externalVersion = startingDb.db.pragma('data_version', { simple: true })
    const startingKeys = new Map<string, string>()
    const ownWrite = <T>(write: () => T): T => {
      const before = this.changes(startingDb)
      if (before !== expectedChanges) {
        interest.pending.set(mailbox, interest.pending.get(mailbox) === true)
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
      interest.parked.set(address, {})
    }
    park(mailbox)
    const transientExclusions = Boolean(reservedTypes?.size)
    try {
      const reconciled = new Set<string>()
      const replanned = new Set<string>()
      for (;;) {
        const db = this.deps.getDb()
        if (!active() || !db) {
          return
        }
        if (db.db.isTransaction) {
          return
        }
        const chosen = await selectSessionMail({
          ...this.deps,
          db,
          mailbox,
          target,
          reservedTypes,
          reconciled,
          park,
          ownWrite,
          current: active,
          settlementOnly,
          settle: (read) => this.reconcileIssued(db, sessionId, read)
        })
        if (!active()) {
          return
        }
        if (!chosen) {
          return
        }
        mailbox = chosen.address
        target = chosen.target
        const batch = chosen.batch
        let { messages, reference } = batch
        const manifest = reference.manifest
        if (!manifest) {
          return
        }
        const neverAdmitted = Boolean(reference.nonAdmission)
        messages = messages
          .map((message) => db.getMessageById(message.id))
          .filter((message) => message !== undefined)
        const issued = readMailHandoff(messages[0]?.handoff)
        if (issued?.kind !== 'structured') {
          return
        }
        reference = issued
        const current = () =>
          active() &&
          currentSessionMail(
            { ...this.deps, db },
            {
              address: mailbox,
              target,
              batch: { messages, reference }
            }
          )
        park(mailbox)
        const body: unknown = JSON.parse(manifest.body)
        if (!isAdmissibleAgentJournalMessageBody(body)) {
          return
        }
        const outcome = await this.deps.host.send({
          sessionId: target.sessionId,
          dispatchId: target.dispatchId,
          operationId: reference.operationId,
          expectedRuntimeFence: manifest.runtimeFence,
          body,
          beforeRun: current
        })
        if (!active()) {
          return
        }
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
            interest.pending.set(mailbox, interest.pending.get(mailbox) === true)
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
      if (active()) {
        interest.inFlight = false
        const changed =
          this.changes(startingDb) !== expectedChanges ||
          startingDb.db.pragma('data_version', { simple: true }) !== externalVersion
        for (const [address, key] of startingKeys) {
          const finalKey = this.admissionKey(startingDb, address, sessionId)
          const before: unknown[] = JSON.parse(key)
          before[1] = expectedChanges
          if (transientExclusions || changed || JSON.stringify(before) !== finalKey) {
            interest.pending.set(address, interest.pending.get(address) === true)
          } else {
            interest.parked.set(address, { key: finalKey })
          }
        }
        const pending = [...interest.pending]
        interest.pending.clear()
        for (const [address, explicit] of pending) {
          interest.parked.delete(address)
          queueMicrotask(() => {
            if (active()) {
              this.offer(address, undefined, explicit)
            }
          })
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
