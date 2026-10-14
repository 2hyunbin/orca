import type { OrchestrationDb } from './db'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type {
  StructuredMailboxPointerHost,
  StructuredPointerTarget
} from './structured-mailbox-pointer-delivery'

/** Exclude pending mail before the limit, leaving the next batch in mailbox order. */
export async function readStructuredMailboxBatch(input: {
  db: OrchestrationDb
  mailboxHandle: string
  target: StructuredPointerTarget
  reservedTypes: ReadonlySet<string> | undefined
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
  host: StructuredMailboxPointerHost
  pendingSends: Iterable<{ contextKey: string; messageId: string }>
}) {
  const session = await input.host.readSessionFacts(input.target.sessionId)
  const contextClearOperationId = input.host.currentContextClearOperationId(input.target.sessionId)
  const contextKey = JSON.stringify([input.target.sessionId, contextClearOperationId])
  const excluded = new Set(
    Array.from(input.pendingSends)
      .filter((send) => send.contextKey === contextKey)
      .map((send) => send.messageId)
  )
  for (const submission of session?.submissions ?? []) {
    if (submission.dispatchState === 'pending' && submission.mailMessageId) {
      excluded.add(submission.mailMessageId)
    }
  }
  return {
    session,
    contextClearOperationId,
    contextKey,
    hasPending: excluded.size > 0,
    unread: selectOrchestrationPointerBatch({
      db: input.db,
      mailboxHandle: input.mailboxHandle,
      waiters: input.waiters,
      reservedTypes: input.reservedTypes,
      excludeOutstandingDelivery: true,
      excludeMessageIds: [...excluded]
    })
  }
}

/** The chat has it, so `check` must not hand it out again. */
export function markStructuredMailReceived(db: OrchestrationDb, messageId: string): void {
  db.markAsRead([messageId])
  db.markAsDelivered([messageId])
}
