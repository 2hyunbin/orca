import type { Tab } from '../../../shared/tab-types'
import { isAgentSessionConversationName } from '../../../shared/agent-session-conversation-name'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from './structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'

type ChatTabNameSource = Pick<
  Tab,
  'entityId' | 'worktreeId' | 'executionHostId' | 'customLabel' | 'label'
>

/** A chat tab's name, read once outside React (labels built in plain functions): the same order
 *  the tab strip uses, from the host's feed as it stands now. Null while the chat has no name.
 *  Without `state`, a tab from before hosts were stamped on tabs finds no host and shows only a
 *  name of its own. */
export function readStructuredChatTabSavedName(
  tab: ChatTabNameSource,
  state?: WorktreeRuntimeOwnerState
): string | null {
  const owner = state ? structuredAgentSessionOwnerForTab(state, tab) : tab.executionHostId
  const target = structuredAgentSessionTargetForHost(owner)
  const name = target
    ? getStructuredAgentSessionStatusFeed(target).getSnapshot().get(tab.entityId)?.conversationName
    : undefined
  return tab.customLabel?.trim() || (isAgentSessionConversationName(name) ? name : null)
}

/** The chat tab's shown label: its name, else the tab's default label. */
export function readStructuredChatTabName(
  tab: ChatTabNameSource,
  state?: WorktreeRuntimeOwnerState
): string {
  return readStructuredChatTabSavedName(tab, state) ?? tab.label
}
