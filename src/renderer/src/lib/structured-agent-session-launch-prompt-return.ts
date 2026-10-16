import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-send-mutation'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-hand-back'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { agentSessionWriteNoticeText } from '@/components/native-chat/agent-session-write-notice-text'
import { readNativeChatComposerDraft, updateNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import type { StagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'

/** Puts a launch's text in its chat's composer, unless its sender keeps it. True when it did; a
 *  draft write that throws is reported in the chat instead, and never stops its caller. */
export function handBackStagedPrompt(prompt: StagedStructuredLaunchPrompt): boolean {
  if (prompt.callerKeepsText || prompt.discarded) {
    return false
  }
  try {
    if (prompt.sourceDraft) {
      const scopeKey = `agent-session:${prompt.sessionId}`
      const current = readNativeChatComposerDraft(scopeKey)
      if (current.text || current.images.length) return false
      updateNativeChatComposerDraft(scopeKey, prompt.sourceDraft, 'immediate')
      return true
    }
    handBackStructuredAgentSessionMessage(
      prompt.sessionId,
      `launch-${prompt.sessionId}`,
      structuredAgentSessionSendBody(prompt.text, [])
    )
    return true
  } catch (error) {
    console.error(
      '[native-chat-send] a launch message could not be put back in the composer',
      error
    )
    publishStructuredAgentSessionSends(prompt.sessionId, {
      notice: agentSessionWriteNoticeText(['messageNotSaved'])
    })
    return false
  }
}

