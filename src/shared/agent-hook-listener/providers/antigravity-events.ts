import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readLastUserPromptFromTranscript } from '../transcript-lines'
import { readAntigravityToolCall } from './antigravity-tool-fields'
import { isAntigravityStopStillBusy } from './antigravity-event-rules'
import {
  hasOutstandingAntigravitySubagents,
  isAntigravitySubagentHook
} from './antigravity-subagent-roster'
import { continueMainAgentStatus, foldAgentLeadStatus } from '../../agent-lead-status-fold'

export function isAntigravityFeedbackTool(toolName: string | undefined): boolean {
  return toolName === 'ask_question' || toolName === 'ask_permission'
}

export function normalizeAntigravityEvent(
  state: HookListenerState,
  hookEventName: unknown,
  hookPromptText: string,
  paneKey: string,
  hookEventPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  let eventName = hookEventName
  let hookPayload = hookEventPayload
  let promptText = hookPromptText
  let roster = state.antigravitySubagentRosterByPaneKey.get(paneKey)
  const hookConversationId = readFirstString(hookPayload, ['conversationId', 'conversation_id'])
  if (roster && hookConversationId && hookConversationId !== roster.parentConversationId) {
    if (!isAntigravitySubagentHook(state, paneKey, hookPayload)) {
      state.antigravitySubagentRosterByPaneKey.delete(paneKey)
      roster = undefined
    } else {
      const finished = eventName === 'Stop' && !isAntigravityStopStillBusy(hookPayload)
      roster.children.set(hookConversationId, !finished)
      if (!finished || !roster.idleParentStop || hasOutstandingAntigravitySubagents(roster)) {
        return null
      }
      // The parent ended its turn before this last helper; its idle Stop now completes the pane.
      eventName = 'Stop'
      hookPayload = roster.idleParentStop
      promptText = ''
    }
  }
  const transcriptPath = readFirstString(hookPayload, ['transcriptPath', 'transcript_path'])
  const conversationId = readFirstString(hookPayload, ['conversationId', 'conversation_id'])
  const toolName = readAntigravityToolCall(hookPayload).toolName
  if (conversationId && toolName === 'invoke_subagent') {
    roster ??= { parentConversationId: conversationId, launches: 0, children: new Map() }
    state.antigravitySubagentRosterByPaneKey.set(paneKey, roster)
    if (eventName === 'PostToolUse' && !readFirstString(hookPayload, ['error'])) {
      roster.launches += 1
    }
  }
  if (eventName === 'PreInvocation') {
    state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  } else if (
    transcriptPath &&
    eventName !== 'Stop' &&
    state.antigravityCompletedTranscriptByPaneKey.get(paneKey) === transcriptPath
  ) {
    // Ignore bookkeeping PostToolUse after Stop so finished rows do not resurrect.
    return null
  }

  const stopStillBusy = eventName === 'Stop' && isAntigravityStopStillBusy(hookPayload)
  // Helpers outlive the parent's turn: they hold the pane open whatever fullyIdle says.
  const heldByHelpers = roster ? hasOutstandingAntigravitySubagents(roster) : false
  const leadState =
    eventName === 'PreToolUse' && isAntigravityFeedbackTool(toolName)
      ? 'waiting'
      : eventName === 'Stop'
        ? stopStillBusy && !heldByHelpers
          ? 'working'
          : 'done'
        : eventName === 'PreInvocation' ||
            eventName === 'PostInvocation' ||
            eventName === 'PreToolUse' ||
            eventName === 'PostToolUse'
          ? 'working'
          : null
  if (!leadState) {
    return null
  }
  const stateName = foldAgentLeadStatus({
    leadState,
    childWorkLiveness: heldByHelpers ? 'working' : null
  }).stateName
  if (roster) {
    // Only a fully idle Stop may complete the pane once its last helper finishes.
    roster.idleParentStop =
      leadState === 'done' && heldByHelpers && !stopStillBusy ? hookPayload : undefined
    roster.mainAgent = continueMainAgentStatus(roster.mainAgent, { state: leadState }, Date.now())
  }

  const resetsTurn = isNewTurnEvent('antigravity', eventName)
  // Cache prompts per turn instead of rescanning large transcripts per hook.
  const cachedPrompt = resetsTurn ? undefined : state.lastPromptByPaneKey.get(paneKey)
  const effectivePrompt =
    promptText || cachedPrompt || readLastUserPromptFromTranscript(transcriptPath) || ''
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('antigravity', eventName, hookPayload),
    { resetOnNewTurn: resetsTurn }
  )

  const payload = normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, effectivePrompt, {
      resetOnNewTurn: resetsTurn
    }),
    agentType: 'antigravity',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    ...(roster?.mainAgent ? { mainAgent: roster.mainAgent } : {})
  })
  // Stop between tools can report fullyIdle=false; only an idle Stop is terminal.
  if (eventName === 'Stop' && !stopStillBusy) {
    if (transcriptPath) {
      state.antigravityCompletedTranscriptByPaneKey.set(paneKey, transcriptPath)
    }
  }
  return payload
}
