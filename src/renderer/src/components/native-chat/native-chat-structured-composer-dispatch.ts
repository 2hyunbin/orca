import type { StructuredAgentSessionCommandOutcome } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { NativeChatFollowUpDelivery } from '../../../../shared/native-chat-follow-up-delivery'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string,
  delivery: NativeChatFollowUpDelivery,
  attachments: readonly NativeChatComposerImageAttachment[] = []
): Promise<Omit<StructuredAgentSessionCommandOutcome, 'handled'> & { revealsTranscript: boolean }> {
  const { handled, ...command } = await transport.dispatchCommand(text)
  // A command's reveal, if any, came at the press; a message reveals unless it waits as a queued card.
  if (handled) {
    return { ...command, revealsTranscript: false }
  }
  const admission = transport.send(text, attachments, delivery)
  return { accepted: admission !== false, error: null, revealsTranscript: admission === true }
}
