import type { OrchestrationDb } from '../orchestration-db'
import type { MessageRow } from '../../types'
import type { AutomaticMailHandoff } from '../../mail-handoff'
import { exposeMessageListTimestamps } from '../utc-timestamp'
import { generateId } from '../generated-id'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'

export function mailboxHandoffAuthority(this: OrchestrationDb, mailbox: string): string {
  if (mailbox.startsWith('run:')) {
    return (
      JSON.stringify(
        this.db
          .prepare(`SELECT consumer_generation, coordinator_handle,
      coordinator_orca_session_id FROM runs WHERE id = ? AND legacy = 0`)
          .get(mailbox.slice(4))
      ) ?? ''
    )
  }
  if (mailbox.startsWith('dispatch:')) {
    return (
      JSON.stringify(
        this.db
          .prepare(`SELECT consumer_generation, assignee_handle, status
      FROM dispatch_contexts WHERE id = ?`)
          .get(mailbox.slice(9))
      ) ?? ''
    )
  }
  return mailbox
}

export function getAutomaticMailCandidates(
  this: OrchestrationDb,
  mailbox: string,
  options: { afterSequence: number; excludeTypes: readonly string[]; limit: number }
): MessageRow[] {
  const exclusions = options.excludeTypes.length
    ? `AND type NOT IN (${options.excludeTypes.map(() => '?').join(',')})`
    : ''
  // Filter parked/settled owners in SQL so an old prefix cannot hide fresh successor mail.
  // SAFETY: SQLite rows come from the messages schema, as in getUnreadMessages.
  return exposeMessageListTimestamps(
    this.db
      .prepare(`SELECT * FROM messages
    WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
      AND pointer_enter_pending = 0 AND sequence > ? ${exclusions}
      AND (handoff IS NULL OR CASE WHEN json_valid(handoff) THEN
        json_extract(handoff, '$.kind') IN ('structured', 'terminal') AND
        (recovery_used = 0 OR json_extract(handoff, '$.phase') = 'reserved') ELSE 0 END)
    ORDER BY sequence LIMIT ?`)
      .all(mailbox, options.afterSequence, ...options.excludeTypes, options.limit) as MessageRow[]
  )
}

export function reserveMailHandoff(
  this: OrchestrationDb,
  mailbox: string,
  message: MessageRow,
  reference: AutomaticMailHandoff,
  recovery: boolean
): MessageRow | undefined {
  return runLifecycleWriteTransaction(this.db, 'mail_handoff_reservation', () => {
    if (this.mailboxHandoffAuthority(mailbox) !== reference.authority) {
      return undefined
    }
    const handoff = JSON.stringify(reference)
    const changed = this.db
      .prepare(`UPDATE messages SET handoff = ?,
    recovery_used = CASE WHEN ? THEN 1 ELSE recovery_used END
    WHERE id = ? AND to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
      AND pointer_enter_pending = 0 AND handoff IS ? AND (? = 0 OR recovery_used = 0)`)
      .run(
        handoff,
        recovery ? 1 : 0,
        message.id,
        mailbox,
        message.handoff ?? null,
        recovery ? 1 : 0
      )
    return changed.changes ? this.getMessageById(message.id) : undefined
  })
}

export function isMailHandoffCurrent(
  this: OrchestrationDb,
  mailbox: string,
  messages: readonly MessageRow[],
  authority: string
): boolean {
  return (
    this.mailboxHandoffAuthority(mailbox) === authority &&
    messages.every((message) => {
      const current = this.getMessageById(message.id)
      return (
        current?.to_handle === mailbox &&
        current.read === 0 &&
        current.delivery_contract === 'current_delivery' &&
        (current.handoff ?? null) === (message.handoff ?? null)
      )
    })
  )
}

export function recordMailHandoff(
  this: OrchestrationDb,
  mailbox: string,
  messages: readonly MessageRow[],
  reference: AutomaticMailHandoff
): void {
  runLifecycleWriteTransaction(this.db, 'mail_handoff_receipt', () => {
    if (this.mailboxHandoffAuthority(mailbox) !== reference.authority) {
      return
    }
    const update = this.db.prepare(`UPDATE messages SET handoff = ?,
    delivered_at = CASE WHEN ? THEN COALESCE(delivered_at, datetime('now')) ELSE delivered_at END
    WHERE id = ? AND to_handle = ? AND read = 0 AND handoff IS ?`)
    for (const message of messages) {
      update.run(
        JSON.stringify(reference),
        reference.phase === 'offered' ? 1 : 0,
        message.id,
        mailbox,
        message.handoff ?? null
      )
    }
  })
}

// Runs inside the existing validated delivery transaction, on first fetch and every replay.
export function recordUnknownMailRead(
  this: OrchestrationDb,
  messages: readonly MessageRow[]
): void {
  const update = this.db.prepare(`UPDATE messages SET handoff = ?, pointer_enter_pending = 0,
    pointer_pty_id = NULL, pointer_process_incarnation = NULL WHERE id = ? AND read = 0`)
  for (const message of messages) {
    update.run(
      JSON.stringify({ version: 1, kind: 'unknown', id: generateId('handoff') }),
      message.id
    )
  }
}

export function getOpenMailHandoffHandles(this: OrchestrationDb): string[] {
  // SAFETY: the SELECT fixes the only column of these SQLite rows.
  return (
    this.db
      .prepare(`SELECT DISTINCT to_handle FROM messages
    WHERE read = 0 AND delivery_contract = 'current_delivery'
      AND (pointer_enter_pending > 0 OR (handoff IS NOT NULL AND (recovery_used = 0 OR CASE WHEN json_valid(handoff)
        THEN json_extract(handoff, '$.phase') = 'reserved' ELSE 0 END)))`)
      .all() as { to_handle: string }[]
  ).map((row) => row.to_handle)
}

export type MailHandoffStoreMethods = {
  mailboxHandoffAuthority: typeof mailboxHandoffAuthority
  getAutomaticMailCandidates: typeof getAutomaticMailCandidates
  reserveMailHandoff: typeof reserveMailHandoff
  isMailHandoffCurrent: typeof isMailHandoffCurrent
  recordMailHandoff: typeof recordMailHandoff
  recordUnknownMailRead: typeof recordUnknownMailRead
  getOpenMailHandoffHandles: typeof getOpenMailHandoffHandles
}

export function attachMailHandoffStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    mailboxHandoffAuthority,
    getAutomaticMailCandidates,
    reserveMailHandoff,
    isMailHandoffCurrent,
    recordMailHandoff,
    recordUnknownMailRead,
    getOpenMailHandoffHandles
  })
}
