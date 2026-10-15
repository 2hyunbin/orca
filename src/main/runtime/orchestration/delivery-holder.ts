/**
 * Mail handed to a reader is held by the turn it was handed to: a batch `check` fetched (its
 * `deliveries.holder_*`), or the turn a mail notice opened (the chat's own journal). How that turn
 * ended is read on every pass, never stored:
 * - running, ended, stopped: the reader has the mail, decided with it, or a person stopped it.
 *   Fetched mail then is not new mail, and nothing offers it again.
 * - cut: the turn ended with nobody asking (Orca quit, the provider died). Its mail is offered once
 *   more, bounded by `reoffered_by_runtime` (delivery-holder-store.ts).
 * - unknown: nothing is decided either way, so no unknown state can hold mail back.
 * The holder never holds a notice back: mail reaches a busy chat as a queued card, like any message.
 */

import type { OrchestrationDb } from './db'
import type { DeliveryRow } from './types'
import {
  deliveryHolderOf,
  type DeliveryHolder,
  type DeliveryReofferArm
} from './db/messages/delivery-holder-store'
import type { OrchestrationMailNotice } from '../../../shared/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'

export type HolderTurnEnd = 'running' | 'ended' | 'stopped' | 'cut-restart' | 'cut' | 'unknown'

export type SessionHeldTurns = {
  end: (turnItemId: string) => HolderTurnEnd
  newestTurnNotice: () => { end: HolderTurnEnd; notice: OrchestrationMailNotice } | null
}

export type DeliveryHolderReader = {
  /** The turn a `check` from this caller runs in; null when none is known, which records no holder. */
  holderOf: (caller: { sessionId: string | null; handle: string }) => DeliveryHolder | null
  /** Null when the chat cannot be read now. */
  sessionTurns: (sessionId: string) => Promise<SessionHeldTurns | null>
  terminalTurnEnd: (holder: Extract<DeliveryHolder, { kind: 'terminal' }>) => HolderTurnEnd
  runtimeId: () => string
}

function reofferArm(end: HolderTurnEnd): DeliveryReofferArm | null {
  return end === 'cut-restart' ? 'restart' : end === 'cut' ? 'cut' : null
}

async function holderTurnEnd(
  holder: DeliveryHolder,
  reader: DeliveryHolderReader
): Promise<HolderTurnEnd> {
  if (holder.kind === 'terminal') {
    return reader.terminalTurnEnd(holder)
  }
  const turns = await reader.sessionTurns(holder.sessionId).catch(() => null)
  return turns ? turns.end(holder.turnItemId) : 'unknown'
}

type ClaimedEnd = { delivery: DeliveryRow; end: HolderTurnEnd } | null

async function claimedDeliveryEnd(
  db: OrchestrationDb,
  mailboxHandle: string,
  reader: DeliveryHolderReader
): Promise<ClaimedEnd> {
  const delivery = db.getClaimedMailboxDelivery?.(mailboxHandle)
  const holder = delivery ? deliveryHolderOf(delivery) : null
  return delivery && holder ? { delivery, end: await holderTurnEnd(holder, reader) } : null
}

/** A cut holder lets its batch go, its unread mail offered once more; answers the batch whose
 *  members are not new mail: its holder has it in hand, decided with it, or was stopped. */
function settle(db: OrchestrationDb, claimed: ClaimedEnd, reader: DeliveryHolderReader) {
  const arm = claimed ? reofferArm(claimed.end) : null
  if (claimed && arm) {
    db.releaseCutDelivery({ delivery: claimed.delivery, arm, runtimeId: reader.runtimeId() })
  }
  return heldDeliveryId(claimed)
}

function heldDeliveryId(claimed: ClaimedEnd): string | undefined {
  return claimed && ['running', 'ended', 'stopped'].includes(claimed.end)
    ? claimed.delivery.id
    : undefined
}

export async function settleClaimedDelivery(
  db: OrchestrationDb,
  mailboxHandle: string,
  reader: DeliveryHolderReader
): Promise<string | undefined> {
  return settle(db, await claimedDeliveryEnd(db, mailboxHandle, reader), reader)
}

/** The terminal lane's synchronous settle: a terminal holder is read now; a chat's waits for its
 *  own lane. */
export function settleClaimedTerminalDelivery(
  db: OrchestrationDb,
  mailboxHandle: string,
  reader: DeliveryHolderReader
): string | undefined {
  const delivery = db.getClaimedMailboxDelivery?.(mailboxHandle)
  const holder = delivery ? deliveryHolderOf(delivery) : null
  return delivery && holder?.kind === 'terminal'
    ? settle(db, { delivery, end: reader.terminalTurnEnd(holder) }, reader)
    : undefined
}

/**
 * A notice's turn cut before it ran `check` leaves its mail pointed and unread with no batch: the
 * chat's newest turn, when this mailbox's notice opened it and it was cut, gets that mail once more.
 */
export async function reofferCutNotice(
  db: OrchestrationDb,
  mailboxHandle: string,
  sessionId: string,
  reader: DeliveryHolderReader
): Promise<void> {
  if (!db.hasPointedUnfetchedMail?.(mailboxHandle)) {
    return
  }
  const newest = (await reader.sessionTurns(sessionId).catch(() => null))?.newestTurnNotice()
  const arm = newest ? reofferArm(newest.end) : null
  if (!newest || !arm || newest.notice.mailbox !== mailboxHandle) {
    return
  }
  db.reofferMailboxMessages({
    mailboxHandle,
    messageIdsJson: JSON.stringify(newest.notice.messages.map((message) => message.messageId)),
    arm,
    runtimeId: reader.runtimeId()
  })
}

/** Whether a queued card still owes its send: a mail notice owes none once every message it points
 *  at was read or is in a batch its holder has in hand; any other card always does. */
export async function queuedCardOwed(
  db: OrchestrationDb | null,
  body: AgentJournalMessageItem,
  reader: DeliveryHolderReader
): Promise<boolean> {
  const notice = body.from?.orchestration
  if (!db || notice?.message !== 'mail-notice') {
    return true
  }
  const excluded = heldDeliveryId(await claimedDeliveryEnd(db, notice.mailbox, reader))
  const ids = notice.messages.map((message) => message.messageId)
  return (db.getPointerOwedMessageIds?.(notice.mailbox, ids, excluded) ?? ids).length > 0
}
