import type { AgentMainAgentStatus } from '../../agent-status-types'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'

/** agy runs invoke_subagent helpers in-process under their own conversationId; none names its parent. */
export type AntigravitySubagentRoster = {
  parentConversationId: string
  /** Successful invoke_subagent calls; a helper may post its first hook before the parent's PostToolUse. */
  launches: number
  /** Helper conversation id to whether it is still working. */
  children: Map<string, boolean>
  /** The parent's idle Stop, replayed once its last helper finishes. */
  idleParentStop?: Record<string, unknown>
  mainAgent?: AgentMainAgentStatus
}

export function hasOutstandingAntigravitySubagents(roster: AntigravitySubagentRoster): boolean {
  return (
    roster.launches > roster.children.size ||
    [...roster.children.values()].some((working) => working)
  )
}

/** Helper hooks never speak for the pane; a foreign conversation with user input is a new user conversation. */
export function isAntigravitySubagentHook(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): boolean {
  const roster = state.antigravitySubagentRosterByPaneKey.get(paneKey)
  const conversationId = readFirstString(hookPayload, ['conversationId', 'conversation_id'])
  if (!roster || !conversationId || conversationId === roster.parentConversationId) {
    return false
  }
  return roster.children.has(conversationId) || !readFirstString(hookPayload, ['lastUserInput'])
}

/** Resume the parent, never a helper: a helper's hook can complete the pane for its parent. */
export function withAntigravityParentConversation(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): Record<string, unknown> {
  const roster = state.antigravitySubagentRosterByPaneKey.get(paneKey)
  return roster && isAntigravitySubagentHook(state, paneKey, hookPayload)
    ? { ...hookPayload, conversationId: roster.parentConversationId }
    : hookPayload
}
