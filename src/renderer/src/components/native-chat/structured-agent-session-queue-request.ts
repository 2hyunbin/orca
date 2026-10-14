import type { StructuredAgentSessionAttachment } from '../../../../shared/structured-agent-session-send-mutation'
import type { StructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'

export type StructuredAgentSessionQueueDelivery = {
  capability: StructuredAgentSessionHostCapabilityState
  enabled: boolean
  forced?: 'queue' | 'steer'
}

export type StructuredAgentSessionSendIntent = 'default' | 'alternate'

/** Whether a send made now asks to be queued: a host known to queue, with queueing enabled. */
export function structuredAgentSessionNewSendsQueue(
  queue: StructuredAgentSessionQueueDelivery
): boolean {
  return (
    queue.capability === 'supported' && (queue.forced ? queue.forced === 'queue' : queue.enabled)
  )
}

/** Whether the host holds a send as a card while the agent works: only text, which is all its
 *  queue takes. */
export function structuredAgentSessionQueueRequest(
  queue: StructuredAgentSessionQueueDelivery,
  attachments: readonly StructuredAgentSessionAttachment[],
  intent?: StructuredAgentSessionSendIntent
): 'queue-if-active' | undefined {
  const selected = intent === 'alternate' ? { ...queue, enabled: !queue.enabled } : queue
  return structuredAgentSessionNewSendsQueue(selected) && attachments.length === 0
    ? 'queue-if-active'
    : undefined
}
