import type { OrchestrationDb, MessageRow } from './db'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from './db/messages/mailbox-routing-page'
import type { StructuredMailHandoff } from './mail-handoff'

export function readMailHandoffCohort(
  db: OrchestrationDb,
  mailbox: string,
  reference: StructuredMailHandoff,
  excludeTypes: readonly string[],
  accept?: (batch: { messages: MessageRow[]; reference: StructuredMailHandoff }) => boolean
): { messages: MessageRow[]; reference: StructuredMailHandoff } | null {
  const members = reference.manifest?.members
  if (!members) {
    return null
  }
  const messages = db.getAutomaticMailCandidates(mailbox, {
    afterSequence: 0,
    excludeTypes,
    limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT,
    members
  })
  const batch = { messages, reference }
  return messages.length === members.length &&
    messages.every(
      (message, index) =>
        message.id === members[index] && message.handoff === JSON.stringify(reference)
    ) &&
    (!accept || accept(batch))
    ? batch
    : null
}
