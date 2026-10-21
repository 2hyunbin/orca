import type { AgentStatusEntry } from './agent-status-types'
import { resolveNativeChatTranscriptAgent } from './native-chat-agent-support'
import { nativeChatAskDismissKey, parseAskFromStatus, type AskPrompt } from './native-chat-ask'

export function nativeChatOmpPromptIdentity(
  status: AgentStatusEntry | null | undefined,
  prompt: AskPrompt
): string | null {
  if (
    !status ||
    resolveNativeChatTranscriptAgent(status.agentType) !== 'omp' ||
    (status.state !== 'waiting' && status.state !== 'blocked') ||
    nativeChatAskDismissKey(parseAskFromStatus(status.interactivePrompt, status.toolName)) !==
      nativeChatAskDismissKey(prompt)
  ) {
    return null
  }
  return JSON.stringify([status.state, status.stateStartedAt, status.turnStartedAt])
}
