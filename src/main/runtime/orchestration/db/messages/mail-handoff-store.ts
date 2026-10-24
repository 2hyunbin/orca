import type { OrchestrationDb } from '../orchestration-db'
import type { MessageRow } from '../../types'
import type { AutomaticMailHandoff } from '../../mail-handoff'
import { exposeMessageListTimestamps } from '../utc-timestamp'
import { generateId } from '../generated-id'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import { potentiallyLiveRemoteAttachmentSql } from '../federation/remote-attachment-liveness'

export function mailboxHandoffAuthority(
  this: OrchestrationDb,
  mailbox: string,
  identity: string | readonly [pane: string, handle: string] = ''
): string {
  if (mailbox.startsWith('run:')) {
    const row = this.db
      .prepare(`SELECT consumer_generation, coordinator_handle,
      coordinator_pane_key, coordinator_orca_session_id, coordinator_orca_session_id_generation
      FROM runs WHERE id = ? AND legacy = 0
      AND (coordinator_handle IS NOT NULL OR coordinator_pane_key IS NOT NULL OR
        (coordinator_orca_session_id IS NOT NULL AND
         coordinator_orca_session_id_generation = consumer_generation))`)
      .get(mailbox.slice(4))
    return row ? JSON.stringify(['run', row]) : ''
  }
  if (mailbox.startsWith('dispatch:')) {
    const id = mailbox.slice(9)
    let route = typeof identity === 'string' ? identity : identity[0]
    const handle = typeof identity === 'string' ? identity : identity[1]
    const routed = this.getActiveDispatchForIdentity(handle, route)
    if (routed?.assignee_handle === handle) {
      route = handle
    }
    const local = this.db
      .prepare(`SELECT consumer_generation, assignee_handle, assignee_pane_key,
      assignee_orca_session_id, process_incarnation FROM dispatch_contexts
      WHERE id = ? AND status IN ('pending', 'dispatched')
      AND (? = '' OR id = ? OR assignee_orca_session_id = ?)`)
      .get(id, route, routed?.id ?? null, route)
    if (local) {
      return JSON.stringify([route, 'dispatch', local])
    }
    const attachmentId = routed ? null : this.findActiveRemoteAttachmentForPane(route)?.dispatch_id
    const attachment = this.db
      .prepare(`SELECT consumer_generation, home_run_id, pane_key,
      terminal_handle, process_incarnation FROM remote_dispatch_attachments
      WHERE dispatch_id = ? AND ${potentiallyLiveRemoteAttachmentSql()}
      AND (? = '' OR dispatch_id = ?)`)
      .get(id, route, attachmentId ?? null)
    return attachment ? JSON.stringify([route, 'attachment', attachment]) : ''
  }
  return mailbox
}

function currentAuthority(db: OrchestrationDb, mailbox: string, expected: string): boolean {
  if (!expected) {
    return false
  }
  let route: unknown = ''
  if (mailbox.startsWith('dispatch:')) {
    try {
      const parsed: unknown = JSON.parse(expected)
      route = Array.isArray(parsed) ? parsed[0] : undefined
    } catch {
      return false
    }
  }
  return typeof route === 'string' && db.mailboxHandoffAuthority(mailbox, route) === expected
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
    if (!currentAuthority(this, mailbox, reference.authority)) {
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
    currentAuthority(this, mailbox, authority) &&
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
    if (!currentAuthority(this, mailbox, reference.authority)) {
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
