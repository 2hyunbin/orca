import type { StructuredAgentSessionAttachment } from '../../../../shared/structured-agent-session-send-mutation'
import type { NativeChatFollowUpDelivery } from '../../../../shared/native-chat-follow-up-delivery'
import type { StructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'

export type StructuredAgentSessionQueueDelivery = {
  capability: StructuredAgentSessionHostCapabilityState
  enabled: boolean
  forced?: NativeChatFollowUpDelivery
}

/** Whether a send made now asks to be queued: a host known to queue, and queue is chosen. */
export function structuredAgentSessionNewSendsQueue(
  queue: StructuredAgentSessionQueueDelivery,
  delivery: NativeChatFollowUpDelivery = queue.enabled ? 'queue' : 'steer'
): boolean {
  return queue.capability === 'supported' && (queue.forced ?? delivery) === 'queue'
}

/** Whether the host holds a send as a card while the agent works: only text, which is all its
 *  queue takes. */
export function structuredAgentSessionQueueRequest(
  queue: StructuredAgentSessionQueueDelivery,
  attachments: readonly StructuredAgentSessionAttachment[],
  delivery?: NativeChatFollowUpDelivery
): 'queue-if-active' | undefined {
  return structuredAgentSessionNewSendsQueue(queue, delivery) && attachments.length === 0
    ? 'queue-if-active'
    : undefined
}
