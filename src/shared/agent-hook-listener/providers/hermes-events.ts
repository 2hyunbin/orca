import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

/** `on_session_start` is a session boundary, not a turn: Hermes fires it when a session is
 *  opened, switched or reset, and the TUI then sits on its composer awaiting input. Landing it
 *  as `working` showed a phantom spinner on an idle pane and left `terminal wait --for tui-idle`
 *  with a fresh `working` row to veto against until the 30-minute staleness window expired.
 *  `done` + `sessionBoundary` is the same shape Claude and the compatible-lifecycle providers
 *  already use for their own SessionStart. */
const HERMES_EVENT_STATES: Record<string, 'working' | 'waiting' | 'done'> = {
  on_session_start: 'done',
  on_session_end: 'done',
  on_session_finalize: 'done',
  on_session_reset: 'done',
  post_llm_call: 'done',
  pre_approval_request: 'waiting',
  pre_llm_call: 'working',
  pre_tool_call: 'working',
  post_tool_call: 'working',
  post_approval_response: 'working'
}

/** Why: Hermes' background memory/skill review fork runs after the turn ends and fires
 *  `pre_tool_call`/`post_tool_call` on the parent's session, but never `pre_llm_call` or a
 *  turn-end hook, so admitting those would leave a finished pane stuck on `working`. */
function admitsHermesEvent(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  const sessionId = typeof hookPayload.session_id === 'string' ? hookPayload.session_id : ''
  const turn = state.hermesTurnByPaneKey.get(paneKey)
  if (eventName === 'pre_llm_call') {
    if (!turn || turn.ended) {
      state.hermesTurnByPaneKey.set(paneKey, {
        sessionId,
        ended: false,
        childSessionIds: new Set()
      })
    } else if (sessionId !== turn.sessionId) {
      turn.childSessionIds.add(sessionId)
    }
    return true
  }
  if (eventName === 'post_llm_call' || eventName === 'on_session_end') {
    // Why not require turn.sessionId: compression rotates the parent's session id mid-turn.
    if (turn && !turn.childSessionIds.has(sessionId)) {
      turn.ended = true
    }
    return true
  }
  const isToolEvent = eventName === 'pre_tool_call' || eventName === 'post_tool_call'
  return !(isToolEvent && turn?.ended)
}

export function normalizeHermesEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName = typeof eventName === 'string' ? HERMES_EVENT_STATES[eventName] : undefined

  if (!stateName) {
    return null
  }

  if (!admitsHermesEvent(state, paneKey, eventName, hookPayload)) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('hermes', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('hermes', eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('hermes', eventName)
    }),
    agentType: 'hermes',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    // Why only this event: a boundary row means "a new session owns the pane and is awaiting
    // input", which cannot arrive mid-turn. A turn-end `done` must not claim the same.
    ...(eventName === 'on_session_start' ? { sessionBoundary: true } : {})
  })
}
