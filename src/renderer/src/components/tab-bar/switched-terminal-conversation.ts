import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { CliConversationRowAgent } from '../../../../shared/structured-agent-cli-conversation-adoption'

/** The conversation a switch put in a terminal tab, until its agent reports one. Presentation only:
 *  an agent's first report comes with its first prompt, and the switch back is offered before it. */
type SwitchedTerminalConversation = {
  agent: CliConversationRowAgent
  providerSessionId: string
  executionHostId: ExecutionHostId
}

const byTabId = new Map<string, SwitchedTerminalConversation>()

export function seedSwitchedTerminalConversation(
  tabId: string,
  conversation: SwitchedTerminalConversation
): void {
  byTabId.set(tabId, conversation)
}

export function switchedTerminalConversation(
  tabId: string
): SwitchedTerminalConversation | undefined {
  return byTabId.get(tabId)
}

export function forgetSwitchedTerminalConversation(tabId: string): void {
  byTabId.delete(tabId)
}
