/**
 * Mail handed to a reader is held by the turn it was handed to: a batch `check` fetched (its
 * `deliveries.holder_*`), or the turn a mail notice opened (the chat's own journal). How that turn
 * ended is read on every pass, never stored:
 * - running, ended, stopped: the reader has the mail, decided with it, or a person stopped it.
 *   Nothing offers it again: handing a batch out marks its members delivered.
 * - cut: the turn ended with nobody asking (Orca quit, the provider died or failed). Its mail is
 *   offered once more, within the budgets in delivery-holder-store.ts.
 * - unknown: nothing is decided either way, so no unknown state can hold mail back.
 * The holder never holds a notice back: mail reaches a busy chat as a queued card, like any message.
 */

import type { OrchestrationDb } from './db'
import type { DeliveryRow } from './types'
import {
  deliveryHolderOf,
  parseHandOffRef,
  type DeliveryHolder,
  type DeliveryReofferArm,
  type TerminalHandOffRef
} from './db/messages/delivery-holder-store'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  StructuredHeldTurnEnd as HolderTurnEnd,
  StructuredHeldTurnReader as SessionHeldTurns
} from '../../native-chat/agent-session-wire/structured-agent-session-held-turn'

export type { HolderTurnEnd, SessionHeldTurns }

export type DeliveryHolderReader = {
  /** The turn a `check` from this caller runs in; null when none is known, which records no holder. */
  holderOf: (caller: { sessionId: string | null; handle: string }) => DeliveryHolder | null
  /** Null when the chat cannot be read now. */
  sessionTurns: (sessionId: string) => Promise<SessionHeldTurns | null>
  terminalTurnEnd: (ref: TerminalHandOffRef) => HolderTurnEnd
  runtimeId: () => string
}

function reofferArm(end: HolderTurnEnd): DeliveryReofferArm | null {
  return end === 'cut-restart' ? 'restart' : end === 'cut' ? 'cut' : null
}

type Claimed = { delivery: DeliveryRow; end: HolderTurnEnd }

/** The mailbox's outstanding batch and how its holder's turn ended. A chat holder is read from
 *  `turns`, that chat's, which the caller read; any other chat reads unknown. */
function claimedEnd(
  db: OrchestrationDb,
  mailboxHandle: string,
  reader: DeliveryHolderReader,
  turns: SessionHeldTurns | null
): Claimed | null {
  const delivery = db.getOutstandingMailboxDelivery?.(mailboxHandle)
  const holder = delivery ? deliveryHolderOf(delivery) : null
  if (!delivery || !holder) {
    return null
  }
  const end =
    holder.kind === 'terminal'
      ? reader.terminalTurnEnd(holder)
      : turns?.sessionId === holder.sessionId
        ? turns.end(holder.turnItemId)
        : 'unknown'
  return { delivery, end }
}

function heldDeliveryId(claimed: Claimed | null): string | undefined {
  return claimed && ['running', 'ended', 'stopped'].includes(claimed.end)
    ? claimed.delivery.id
    : undefined
}

/** A cut holder lets its batch go, its unread mail offered once more; any other holder keeps it,
 *  and its members, delivered when handed out, are not new mail. */
export function settleClaimedDelivery(
  db: OrchestrationDb,
  mailboxHandle: string,
  reader: DeliveryHolderReader,
  turns: SessionHeldTurns | null = null
): void {
  const claimed = claimedEnd(db, mailboxHandle, reader, turns)
  const arm = claimed ? reofferArm(claimed.end) : null
  if (claimed && arm) {
    db.releaseCutDelivery({ delivery: claimed.delivery, arm, runtimeId: reader.runtimeId() })
  }
}

/** A notice typed into a terminal whose turn was cut before it fetched the mail: that mail is
 *  offered once more. The terminal lane's companion to `settleClaimedDelivery`. */
export function settleTerminalNotices(
  db: OrchestrationDb,
  mailboxHandle: string,
  reader: DeliveryHolderReader
): void {
  const outsideDeliveryId = db.getOutstandingMailboxDelivery?.(mailboxHandle)?.id
  for (const [pointedBy, ids] of db.getPointedNoticeMessages?.(mailboxHandle, outsideDeliveryId) ??
    []) {
    const ref = parseHandOffRef(pointedBy)
    const end = ref && ref.kind !== 'session' ? reader.terminalTurnEnd(ref) : null
    const arm = end ? reofferArm(end) : null
    if (arm) {
      db.reofferMailboxMessages({
        mailboxHandle,
        messageIdsJson: JSON.stringify(ids),
        arm,
        runtimeId: reader.runtimeId(),
        outsideDeliveryId
      })
    }
  }
}

/** Whether settling this mailbox reads a chat's turns: a chat holds its batch, or mail a notice
 *  pointed at is still unread outside it. Two indexed reads, so an idle chat is not opened for none. */
export function settleReadsChatTurns(db: OrchestrationDb, mailboxHandle: string): boolean {
  const outstanding = db.getOutstandingMailboxDelivery?.(mailboxHandle)
  return (
    (outstanding ? deliveryHolderOf(outstanding)?.kind === 'session' : false) ||
    Boolean(db.hasPointedUnfetchedMail?.(mailboxHandle, outstanding?.id))
  )
}

/**
 * A notice's turn cut before it ran `check` leaves its mail pointed and unread with no batch: the
 * chat's newest turn, when this mailbox's notice opened it and it was cut, gets that mail once more.
 */
export function reofferCutNotice(
  db: OrchestrationDb,
  mailboxHandle: string,
  turns: SessionHeldTurns | null,
  runtimeId: string
): void {
  const outsideDeliveryId = db.getOutstandingMailboxDelivery?.(mailboxHandle)?.id
  if (!turns || !db.hasPointedUnfetchedMail?.(mailboxHandle, outsideDeliveryId)) {
    return
  }
  const newest = turns.newestTurnNotice()
  const arm = newest ? reofferArm(newest.end) : null
  if (!newest || !arm || newest.notice.mailbox !== mailboxHandle) {
    return
  }
  db.reofferMailboxMessages({
    mailboxHandle,
    messageIdsJson: JSON.stringify(newest.notice.messages.map((message) => message.messageId)),
    arm,
    runtimeId,
    outsideDeliveryId
  })
}

/** Whether a chat's queued card still owes its send: a mail notice owes none once every message it
 *  points at was read or is in a batch its holder has in hand; any other card always does. A
 *  failed read answers yes: bookkeeping never holds a card back. */
export async function queuedCardOwed(
  db: OrchestrationDb | null,
  reader: DeliveryHolderReader,
  sessionId: string,
  body: AgentJournalMessageItem
): Promise<boolean> {
  const notice = body.from?.orchestration
  if (!db || notice?.message !== 'mail-notice') {
    return true
  }
  try {
    const turns = await reader.sessionTurns(sessionId).catch(() => null)
    const excluded = heldDeliveryId(claimedEnd(db, notice.mailbox, reader, turns))
    const ids = notice.messages.map((message) => message.messageId)
    return (db.getPointerOwedMessageIds?.(notice.mailbox, ids, excluded) ?? ids).length > 0
  } catch {
    return true
  }
}

/** The structured host's mail deps, typed here because the file that installs the host is not. */
export function structuredHostMailDeps(
  getDb: () => OrchestrationDb | null,
  reader: DeliveryHolderReader
): { queuedCardOwed: (sessionId: string, body: AgentJournalMessageItem) => Promise<boolean> } {
  return { queuedCardOwed: (sessionId, body) => queuedCardOwed(getDb(), reader, sessionId, body) }
}
