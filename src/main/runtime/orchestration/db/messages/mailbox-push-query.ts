import type { MessageType, UndeliveredUnreadMessageOptions } from '../../types'

export function mailboxPushQuery(
  toHandle: string,
  types?: MessageType[],
  options?: UndeliveredUnreadMessageOptions
) {
  const conditions = [
    'to_handle = ?',
    'read = 0',
    'delivered_at IS NULL',
    'pointer_enter_pending = 0',
    "delivery_contract = 'current_delivery'"
  ]
  const params: (string | number)[] = [toHandle]
  if (types?.length) {
    conditions.push(`type IN (${types.map(() => '?').join(',')})`)
    params.push(...types)
  }
  if (options?.excludeTypes?.length) {
    conditions.push(`type NOT IN (${options.excludeTypes.map(() => '?').join(',')})`)
    params.push(...options.excludeTypes)
  }
  if (options?.excludeOutstandingDelivery) {
    conditions.push(
      `id NOT IN (SELECT ids.value FROM outstanding_deliveries d, json_each(d.message_ids) ids
                  WHERE d.mailbox_handle = ?)`
    )
    params.push(toHandle)
  }
  if (options?.afterSequence !== undefined) {
    conditions.push('sequence > ?')
    params.push(options.afterSequence)
  }
  if (options?.throughSequence !== undefined) {
    conditions.push('sequence <= ?')
    params.push(options.throughSequence)
  }
  const limitSql = options?.limit === undefined ? '' : ' LIMIT ?'
  if (options?.limit !== undefined) {
    params.push(Math.max(1, Math.floor(options.limit)))
  }
  return {
    sql: `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY sequence${limitSql}`,
    params
  }
}
