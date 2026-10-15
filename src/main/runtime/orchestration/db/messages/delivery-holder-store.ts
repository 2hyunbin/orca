import type { DeliveryRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

/**
 * Who holds a batch `check` handed out: the turn that fetched it. A structured session's turn is
 * its journal turn record; a terminal agent's is its pane's PTY process and the turn its hooks
 * report. A pane, not a terminal handle: a handle is minted per Orca launch, a pane outlives it.
 * Written only when the fetching turn is known, so a holder always names a turn.
 */
export type DeliveryHolder =
  | { kind: 'session'; sessionId: string; turnItemId: string }
  | {
      kind: 'terminal'
      paneKey: string
      processIncarnation: string
      /** The agent conversation its hooks report; null for an agent without hooks. */
      agentSessionId: string | null
      agentTurnStartedAt: number | null
    }

/** How a cut holder's turn ended: Orca's restart, or anything else (provider death, eviction). */
export type DeliveryReofferArm = 'restart' | 'cut'

const HOLDER_ASSIGNMENTS = `holder_session_id = ?, holder_turn_item_id = ?,
  holder_pane_key = ?, holder_process_incarnation = ?,
  holder_agent_session_id = ?, holder_agent_turn_started_at = ?`

/** `id` is a member of batch `?` (none for ''): the one way "in that batch" is asked. */
export const MEMBER_OF_DELIVERY_SQL = `id IN (
  SELECT member.value FROM deliveries AS batch, json_each(batch.message_ids) AS member
  WHERE batch.id = ?)`

function holderValues(holder: DeliveryHolder | null): (string | number | null)[] {
  if (!holder) {
    return [null, null, null, null, null, null]
  }
  return holder.kind === 'session'
    ? [holder.sessionId, holder.turnItemId, null, null, null, null]
    : [
        null,
        null,
        holder.paneKey,
        holder.processIncarnation,
        holder.agentSessionId,
        holder.agentTurnStartedAt
      ]
}

export function deliveryHolderOf(row: DeliveryRow): DeliveryHolder | null {
  if (row.holder_session_id && row.holder_turn_item_id) {
    return {
      kind: 'session',
      sessionId: row.holder_session_id,
      turnItemId: row.holder_turn_item_id
    }
  }
  if (row.holder_pane_key && row.holder_process_incarnation) {
    return {
      kind: 'terminal',
      paneKey: row.holder_pane_key,
      processIncarnation: row.holder_process_incarnation,
      agentSessionId: row.holder_agent_session_id ?? null,
      agentTurnStartedAt: row.holder_agent_turn_started_at ?? null
    }
  }
  return null
}

/** Inside the caller's transaction: a replay re-stamps the turn that now holds the batch. */
export function stampDeliveryHolder(
  db: OrchestrationDb,
  deliveryId: string,
  holder: DeliveryHolder
): void {
  db.db
    .prepare(`UPDATE deliveries SET ${HOLDER_ASSIGNMENTS} WHERE id = ?`)
    .run(...holderValues(holder), deliveryId)
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
    .prepare(
      `SELECT DISTINCT mailbox_handle FROM outstanding_deliveries
       WHERE holder_turn_item_id IS NOT NULL OR holder_process_incarnation IS NOT NULL`
    )
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
        `UPDATE messages SET delivered_at = NULL, ${budget.spend}
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
        `UPDATE deliveries SET ${HOLDER_ASSIGNMENTS}
         WHERE id = ? AND status = 'outstanding'
           AND holder_turn_item_id IS ? AND holder_process_incarnation IS ?
           AND holder_agent_turn_started_at IS ?`
      )
      .run(
        ...holderValues(null),
        delivery.id,
        delivery.holder_turn_item_id ?? null,
        delivery.holder_process_incarnation ?? null,
        delivery.holder_agent_turn_started_at ?? null
      ).changes
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
}

export function attachDeliveryHolderStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getOutstandingMailboxDelivery,
    getClaimedDeliveryMailboxHandles,
    reofferMailboxMessages,
    releaseCutDelivery,
    getPointerOwedMessageIds,
    hasPointedUnfetchedMail
  })
}
