import type { StructuredAgentSessionCommandOutcome } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { StructuredAgentSessionSendIntent } from './structured-agent-session-queue-request'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string,
  attachments: readonly NativeChatComposerImageAttachment[] = [],
  intent?: StructuredAgentSessionSendIntent
): Promise<Omit<StructuredAgentSessionCommandOutcome, 'handled'> & { revealsTranscript: boolean }> {
  const { handled, ...command } = await transport.dispatchCommand(text)
  // A command's reveal, if any, came at the press; a message reveals unless it waits as a queued card.
  if (handled) {
    return { ...command, revealsTranscript: false }
  }
  const admission = intent
    ? transport.send(text, attachments, intent)
    : transport.send(text, attachments)
  return { accepted: admission !== false, error: null, revealsTranscript: admission === true }
}
