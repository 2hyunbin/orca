import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type MessageRow, type OrchestrationDb } from './db'

export type OrchestrationMessageWaiter = { typeFilter: string[] | undefined }

export function messageTypeHasOrchestrationWaiter(
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined,
  messageType: string
): boolean {
  for (const waiter of waiters ?? []) {
    if (!waiter.typeFilter || waiter.typeFilter.includes(messageType)) {
      return true
    }
  }
  return false
}

export function hasUnfilteredOrchestrationWaiter(
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
): boolean {
  for (const waiter of waiters ?? []) {
    if (!waiter.typeFilter) {
      return true
    }
  }
  return false
}

/**
 * The rows a pointer may carry right now.
 *
 * Both delivery lanes — bytes into a PTY, a turn into a structured session — select their batch
 * identically and differ only in what they do with it, so the selection lives here rather than
 * being kept in step in two copies. An unfiltered waiter owns the whole mailbox and yields an
 * empty batch: a caller blocked in `check --wait` preempts pointer delivery entirely.
 *
 * Type exclusion is exact in SQL and no post-filter is owed. The unfiltered case returns above, so
 * every remaining waiter contributes a concrete type list, and `messages.type` is TEXT with no
 * NOCASE collation — `NOT IN` is the same byte-exact test JS would repeat. Selection is synchronous
 * throughout, so no waiter can register partway through it either.
 */
export function selectOrchestrationPointerBatch(input: {
  db: OrchestrationDb
  mailboxHandle: string
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
  reservedTypes: ReadonlySet<string> | undefined
}): MessageRow[] {
  if (hasUnfilteredOrchestrationWaiter(input.waiters)) {
    return []
  }
  // A heartbeat is a worker's state, not a request: the runtime records it on arrival, and the
  // coordinator reads it with its next `check`. Waking a coordinator for one costs a turn for nothing.
  const excludedTypes = new Set(['heartbeat', ...(input.reservedTypes ?? [])])
  for (const waiter of input.waiters ?? []) {
    for (const type of waiter.typeFilter ?? []) {
      excludedTypes.add(type)
    }
  }
  return input.db.getUndeliveredUnreadMessages(input.mailboxHandle, undefined, {
    excludeTypes: [...excludedTypes],
    limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
  })
}

/** Release a staged pointer once none of its messages is still owed: each was read, or fetched
 *  into a batch handed out since staging (`batchAtStaging` names the one outstanding then, holder
 *  or not). Per message, so a batch that only holds other mail never releases it. */
export function shouldReleaseOrchestrationPointer(
  db: OrchestrationDb | null,
  mailboxHandle: string,
  messages: readonly { id: string; type: string }[],
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined,
  batchAtStaging: string | undefined
): boolean {
  if (messages.some((message) => messageTypeHasOrchestrationWaiter(waiters, message.type))) {
    return true
  }
  const ids = messages.map((message) => message.id)
  const outstanding = db?.getOutstandingMailboxDelivery?.(mailboxHandle)?.id
  const owed = db?.getPointerOwedMessageIds?.(
    mailboxHandle,
    ids,
    outstanding === batchAtStaging ? undefined : outstanding
  )
  return owed ? owed.length === 0 : !(db?.areUnreadMessages?.(mailboxHandle, ids) ?? true)
}
