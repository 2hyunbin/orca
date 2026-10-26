import type { AgentHookSource } from '../agent-hook-relay'
import { readAgentEffortLevel } from '../agent-effort-level'
import {
  extractAgentProviderSession,
  readPathFromKeys,
  type AgentProviderSessionMetadata
} from '../agent-session-resume'
import type { HookListenerState } from './listener-state'
import { withHermesPaneSessionId } from './providers/hermes-events'
import { readString } from './tool-input-preview'

/** The provider session a hook names for its pane; child agents' hooks never name their own. */
export function readPaneProviderSession(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  hookPayload: Record<string, unknown>
): AgentProviderSessionMetadata | null {
  if (source === 'codex' && readString(hookPayload, 'agent_id')) {
    return null
  }
  const providerSession = extractAgentProviderSession(
    source,
    source === 'hermes' ? withHermesPaneSessionId(state, paneKey, hookPayload) : hookPayload
  )
  if (!providerSession) {
    return null
  }
  const cwd = readAgentCwd(state, source, paneKey, providerSession.id, hookPayload)
  const effort = readClaudeEffort(state, source, paneKey, providerSession.id, hookPayload)
  return {
    ...providerSession,
    ...(cwd ? { cwd } : {}),
    ...(effort ? { effort } : {})
  }
}

/** Claude 2.1.133+ reports `effort.level` on tool and Stop hooks only, so other events keep the last one. */
function readClaudeEffort(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  sessionId: string,
  hookPayload: Record<string, unknown>
): string | undefined {
  if (source !== 'claude') {
    return undefined
  }
  const effort = hookPayload.effort
  // Why skip subagents: their hooks name the parent session but report the subagent's own effort.
  const reported =
    typeof effort === 'object' &&
    effort !== null &&
    'level' in effort &&
    !readString(hookPayload, 'agent_id')
      ? readAgentEffortLevel(effort.level)
      : undefined
  const previous = state.lastStatusByPaneKey.get(paneKey)?.providerSession
  return reported ?? (previous?.id === sessionId ? previous.effort : undefined)
}

/** The folder the pane's agent started in. Only Claude/Codex hooks are known to report it (Cursor's cwd is a shell command's). */
function readAgentCwd(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  sessionId: string,
  hookPayload: Record<string, unknown>
): string | undefined {
  if (source !== 'claude' && source !== 'codex') {
    return undefined
  }
  const previous = state.lastStatusByPaneKey.get(paneKey)
  const previousCwd = previous?.source === source ? previous.providerSession?.cwd : undefined
  // Claude's hook cwd follows its Bash tool's `cd`; /clear and compact restart in the same process.
  const keepsPreviousFolder =
    previous?.providerSession?.id === sessionId ||
    (source === 'claude' &&
      hookPayload.hook_event_name === 'SessionStart' &&
      (hookPayload.source === 'clear' || hookPayload.source === 'compact'))
  return previousCwd && keepsPreviousFolder ? previousCwd : readPathFromKeys(hookPayload, ['cwd'])
}
