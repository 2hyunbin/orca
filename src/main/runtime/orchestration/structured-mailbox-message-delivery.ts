import type { MessageRow, OrchestrationDb } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import type { SenderNameResolver } from './agent-message-sender'
import type {
  StructuredMailboxPointerHost,
  StructuredPointerTarget,
  StructuredPointerSessionFacts
} from './structured-mailbox-pointer-delivery'
import {
  resolveStructuredMailOperation,
  type StructuredMailOperation
} from './structured-pointer-operation-id'
import {
  retainReasonForDispatch,
  structuredDispatchDelivered,
  type StructuredPointerRetainReason
} from './structured-session-pointer-delivery'
import { structuredMailBody } from './structured-mail-source'
import { markStructuredMailReceived } from './structured-mailbox-pointer-batch'

/** Sends one message, or replays its send; false when the session cannot take any. */
export async function sendStructuredMailboxMessage(
  db: OrchestrationDb,
  mailboxHandle: string,
  target: StructuredPointerTarget,
  message: MessageRow,
  attempt: {
    key: string
    session: StructuredPointerSessionFacts
    fence: number
    retain: (reason: StructuredPointerRetainReason) => void
    answered: () => void
    progressed: () => void
  },
  deps: {
    host: StructuredMailboxPointerHost
    senderName: SenderNameResolver
    getCliCommand: () => OrchestrationCliCommand
    mintedOperations: Map<string, StructuredMailOperation>
  }
): Promise<boolean> {
  const resolved = resolveStructuredMailOperation({
    messageId: message.id,
    submissions: attempt.session.submissions,
    mintedByThisProcess: deps.mintedOperations.get(attempt.key)
  })
  if (resolved.kind === 'park') {
    attempt.retain('turn-unsettled')
    return true
  }
  if (resolved.kind === 'send') {
    // A new admission advances the drain; replaying a retained verdict does not.
    const newlyIssued =
      deps.mintedOperations.get(attempt.key)?.operationId !== resolved.operation.operationId
    deps.mintedOperations.set(attempt.key, resolved.operation)
    const outcome = await deps.host.send({
      sessionId: target.sessionId,
      dispatchId: target.dispatchId,
      operationId: resolved.operation.operationId,
      expectedRuntimeFence: attempt.fence,
      body: structuredMailBody({
        db,
        mailboxHandle,
        dispatchId: target.dispatchId,
        message,
        senderName: deps.senderName,
        cliCommand: deps.getCliCommand()
      }),
      onAnswered: () => {
        attempt.answered()
        if (newlyIssued) {
          attempt.progressed()
        }
      }
    })
    if (outcome.kind === 'unattached') {
      attempt.retain('session-not-attached')
      return false
    }
    // A queued message is the chat's queue's to send, as a person's queued message is.
    if (outcome.kind === 'sent' && !structuredDispatchDelivered(outcome.state)) {
      // Resending under its id replays this verdict and starts nothing.
      attempt.retain(retainReasonForDispatch(outcome.state))
      return true
    }
  }
  // Sent, queued, or a send this lane gave up waiting on that ran after all.
  markStructuredMailReceived(db, message.id)
  deps.mintedOperations.delete(attempt.key)
  attempt.progressed()
  return true
}
