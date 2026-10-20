import type { AppState } from '@/store/types'
import {
  collectAgentPaneConversations,
  resolvePaneLastAgentConversation
} from '@/lib/ai-vault-tab-title-requests'
import { inPlaceSwitchSupportedNow } from '@/lib/in-place-switch-support'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  adoptsCliConversations,
  type CliConversationRowAgent
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { canPaneOfferResumeInNewChat } from './tab-session-history-switch'
import { switchedTerminalConversation } from './switched-terminal-conversation'

export type CliChatResumeSource = {
  tabId: string
  workspaceId: string
  paneKey: string
  agent: CliConversationRowAgent
  providerSessionId: string
  executionHostId: ExecutionHostId
}

/** The pane's last reported conversation, else the one a switch just put in this tab. */
export function resolveCliChatResumeSource(
  state: AppState,
  args: { tab: { id: string; worktreeId: string }; paneKey?: string }
): CliChatResumeSource | null {
  const conversation = args.paneKey
    ? resolvePaneLastAgentConversation(
        state,
        { worktreeId: args.tab.worktreeId, paneKey: args.paneKey },
        adoptsCliConversations
      )
    : collectAgentPaneConversations(state, adoptsCliConversations).find(
        (candidate) => candidate.tabId === args.tab.id
      )
  const leafId = state.terminalLayoutsByTabId[args.tab.id]?.activeLeafId
  const seeded = switchedTerminalConversation(args.tab.id)
  const paneKey = args.paneKey ?? (leafId ? makePaneKey(args.tab.id, leafId) : null)
  if (!conversation) {
    return seeded && paneKey
      ? { tabId: args.tab.id, workspaceId: args.tab.worktreeId, paneKey, ...seeded }
      : null
  }
  if (
    conversation.tabId !== args.tab.id ||
    conversation.worktreeId !== args.tab.worktreeId ||
    // A paired host moves a terminal's conversation only once it switches that agent in place.
    (conversation.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
      !inPlaceSwitchSupportedNow(conversation.executionHostId, conversation.agent)) ||
    !canPaneOfferResumeInNewChat(state, {
      worktreeId: conversation.worktreeId,
      paneKey: conversation.paneKey
    })
  ) {
    return null
  }
  return {
    tabId: conversation.tabId,
    workspaceId: conversation.worktreeId,
    paneKey: conversation.paneKey,
    agent: conversation.agent,
    providerSessionId: conversation.providerSession.id,
    executionHostId: conversation.executionHostId
  }
}
