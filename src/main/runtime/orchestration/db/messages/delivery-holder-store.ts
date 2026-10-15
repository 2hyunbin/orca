import { z } from 'zod'
import type { DeliveryRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

/**
 * The turn a hand-off reached, stored as JSON on the hand-off (`deliveries.holder` for a batch
 * `check` fetched, `messages.pointed_by` for a notice typed into a terminal) and parsed only here.
 * - session: a structured session's journal turn record that fetched the batch.
 * - terminal: the pane, its PTY process and the hook-reported turn that fetched the batch. A pane,
 *   not a terminal handle: a handle is minted per Orca launch, a pane outlives it.
 * - terminal-notice: a notice typed into the pane at `typedAt`; the agent's first turn from then
 *   took it.
 * Written only when the turn is known, so a reference always names one.
 */
const handOffRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: z.string(), turnItemId: z.string() }),
  z.object({
    kind: z.literal('terminal'),
    paneKey: z.string(),
    processIncarnation: z.string(),
    /** The agent conversation its hooks report; null for an agent without hooks. */
    agentSessionId: z.string().nullable(),
    agentTurnStartedAt: z.number().nullable()
  }),
  z.object({
    kind: z.literal('terminal-notice'),
    paneKey: z.string(),
    processIncarnation: z.string(),
    typedAt: z.number()
  })
])

export type HandOffRef = z.infer<typeof handOffRefSchema>
/** What a batch `check` hands out records: never a typed notice. */
export type DeliveryHolder = Exclude<HandOffRef, { kind: 'terminal-notice' }>
export type TerminalHandOffRef = Extract<HandOffRef, { kind: 'terminal' | 'terminal-notice' }>

/** How a cut holder's turn ended: Orca's restart, or anything else (provider death, eviction). */
export type DeliveryReofferArm = 'restart' | 'cut'

/** `id` is a member of batch `?` (none for ''): the one way "in that batch" is asked. */
export const MEMBER_OF_DELIVERY_SQL = `id IN (
  SELECT member.value FROM deliveries AS batch, json_each(batch.message_ids) AS member
  WHERE batch.id = ?)`

/** Null for anything unreadable: no reference, as on every row before v44. */
export function parseHandOffRef(text: string | null | undefined): HandOffRef | null {
  if (!text) {
    return null
  }
  try {
    const parsed = handOffRefSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function deliveryHolderOf(row: DeliveryRow): DeliveryHolder | null {
  const ref = parseHandOffRef(row.holder)
  return ref && ref.kind !== 'terminal-notice' ? ref : null
}

/** Inside the caller's transaction: a replay re-stamps the turn that now holds the batch. */
export function stampDeliveryHolder(
  db: OrchestrationDb,
  deliveryId: string,
  holder: DeliveryHolder
): void {
  db.db
    .prepare('UPDATE deliveries SET holder = ? WHERE id = ?')
    .run(JSON.stringify(holder), deliveryId)
}

/** The mailbox's outstanding batch, holder or not (at most one per mailbox). */
export function getOutstandingMailboxDelivery(
  this: OrchestrationDb,
  mailboxHandle: string
): DeliveryRow | undefined {
  const row = this.db
    .prepare('SELECT id FROM outstanding_deliveries WHERE mailbox_handle = ? LIMIT 1')
    .get(mailboxHandle)
  return typeof row?.id === 'string' ? this.getDeliveryRaw(row.id) : undefined
}

/** Mailboxes whose outstanding batch records its holder ("claimed"): a launch settles them. */
export function getClaimedDeliveryMailboxHandles(this: OrchestrationDb): string[] {
  return this.db
    .prepare('SELECT DISTINCT mailbox_handle FROM outstanding_deliveries WHERE holder IS NOT NULL')
    .all()
    .flatMap((row) =>
      typeof row.mailbox_handle === 'string' && row.mailbox_handle ? [row.mailbox_handle] : []
    )
}

/**
 * Two budgets per message: once per Orca launch after a restart, and once in all after any other
 * cut, so neither spends the other and a provider that dies on every start is not restarted forever.
 */
function reofferBudget(arm: DeliveryReofferArm, runtimeId: string) {
  return arm === 'restart'
    ? {
        spend: 'reoffered_by_runtime = ?',
        allowed: '(reoffered_by_runtime IS NULL OR reoffered_by_runtime != ?)',
        params: [runtimeId]
      }
    : { spend: 'reoffered_after_cut = 1', allowed: 'reoffered_after_cut IS NULL', params: [] }
}

/**
 * Re-arms `messageIds` for one more pointer: unread, already pointed, outside the batch
 * `outsideDeliveryId`, and within the arm's budget. Returns how many it re-armed.
 */
export function reofferMailboxMessages(
  this: OrchestrationDb,
  params: {
    mailboxHandle: string
    /** A JSON array of message ids, as `deliveries.message_ids` stores them. */
    messageIdsJson: string
    arm: DeliveryReofferArm
    runtimeId: string
    outsideDeliveryId?: string
  }
): number {
  const budget = reofferBudget(params.arm, params.runtimeId)
  return Number(
    this.db
      .prepare(
        `UPDATE messages SET delivered_at = NULL, pointed_by = NULL, ${budget.spend}
         WHERE to_handle = ? AND read = 0 AND delivered_at IS NOT NULL
           AND delivery_contract = 'current_delivery'
           AND id IN (SELECT value FROM json_each(?))
           AND ${budget.allowed} AND NOT ${MEMBER_OF_DELIVERY_SQL}`
      )
      .run(
        ...budget.params,
        params.mailboxHandle,
        params.messageIdsJson,
        ...budget.params,
        params.outsideDeliveryId ?? ''
      ).changes
  )
}

/**
 * The cut holder lets go of its batch, and its unread members are offered once more. Compare-and-set
 * on the holder that was read, so a `check` that re-stamped it meanwhile wins.
 */
export function releaseCutDelivery(
  this: OrchestrationDb,
  params: { delivery: DeliveryRow; arm: DeliveryReofferArm; runtimeId: string }
): void {
  const { delivery } = params
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const released = this.db
      .prepare(
        `UPDATE deliveries SET holder = NULL
         WHERE id = ? AND status = 'outstanding' AND holder IS ?`
      )
      .run(delivery.id, delivery.holder ?? null).changes
    if (released > 0) {
      this.reofferMailboxMessages({
        mailboxHandle: delivery.mailbox_handle ?? '',
        messageIdsJson: delivery.message_ids,
        arm: params.arm,
        runtimeId: params.runtimeId
      })
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/** Unread mail a notice pointed at, outside the batch `outsideDeliveryId`: a cut notice turn may
 *  leave it. */
export function hasPointedUnfetchedMail(
  this: OrchestrationDb,
  mailboxHandle: string,
  outsideDeliveryId: string | undefined
): boolean {
  return Boolean(
    this.db
      .prepare(
        `SELECT 1 FROM messages
         WHERE to_handle = ? AND read = 0 AND delivered_at IS NOT NULL
           AND delivery_contract = 'current_delivery' AND NOT ${MEMBER_OF_DELIVERY_SQL}
         LIMIT 1`
      )
      .get(mailboxHandle, outsideDeliveryId ?? '')
  )
}

/** Unread mail typed into a terminal and not fetched since, by the notice that carried it. */
export function getPointedNoticeMessages(
  this: OrchestrationDb,
  mailboxHandle: string,
  outsideDeliveryId: string | undefined
): Map<string, string[]> {
  const byNotice = new Map<string, string[]>()
  const rows = this.db
    .prepare(
      `SELECT id, pointed_by FROM messages
       WHERE to_handle = ? AND read = 0 AND delivered_at IS NOT NULL AND pointed_by IS NOT NULL
         AND NOT ${MEMBER_OF_DELIVERY_SQL}`
    )
    .all(mailboxHandle, outsideDeliveryId ?? '')
  for (const row of rows) {
    if (typeof row.id === 'string' && typeof row.pointed_by === 'string') {
      byNotice.set(row.pointed_by, [...(byNotice.get(row.pointed_by) ?? []), row.id])
    }
  }
  return byNotice
}

/** Which of `messageIds` a pointer still owes: unread, and not in the batch `excludeDeliveryId`. */
export function getPointerOwedMessageIds(
  this: OrchestrationDb,
  mailboxHandle: string,
  messageIds: readonly string[],
  excludeDeliveryId: string | undefined
): string[] {
  if (messageIds.length === 0) {
    return []
  }
  return this.db
    .prepare(
      `SELECT id FROM messages INDEXED BY idx_messages_id
       WHERE to_handle = ? AND read = 0 AND id IN (SELECT value FROM json_each(?))
         AND NOT ${MEMBER_OF_DELIVERY_SQL}`
    )
    .all(mailboxHandle, JSON.stringify(messageIds), excludeDeliveryId ?? '')
    .flatMap((row) => (typeof row.id === 'string' ? [row.id] : []))
}

export type DeliveryHolderStoreMethods = {
  getOutstandingMailboxDelivery: typeof getOutstandingMailboxDelivery
  getClaimedDeliveryMailboxHandles: typeof getClaimedDeliveryMailboxHandles
  reofferMailboxMessages: typeof reofferMailboxMessages
  releaseCutDelivery: typeof releaseCutDelivery
  getPointerOwedMessageIds: typeof getPointerOwedMessageIds
  hasPointedUnfetchedMail: typeof hasPointedUnfetchedMail
  getPointedNoticeMessages: typeof getPointedNoticeMessages
}

export function attachDeliveryHolderStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getOutstandingMailboxDelivery,
    getClaimedDeliveryMailboxHandles,
    reofferMailboxMessages,
    releaseCutDelivery,
    getPointerOwedMessageIds,
    hasPointedUnfetchedMail,
    getPointedNoticeMessages
  })
}
