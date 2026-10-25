import type { AgentHookSource } from '../agent-hook-relay'
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
  const cwd = readAgentCwd(state, source, paneKey, hookPayload)
  return cwd ? { ...providerSession, cwd } : providerSession
}

/** The folder the pane's agent started in. Only Claude/Codex hooks are known to report it (Cursor's cwd is a shell command's). */
function readAgentCwd(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  hookPayload: Record<string, unknown>
): string | undefined {
  if (source !== 'claude' && source !== 'codex') {
    return undefined
  }
  const previous = state.lastStatusByPaneKey.get(paneKey)
  const previousCwd = previous?.source === source ? previous.providerSession?.cwd : undefined
  // Claude's hook cwd follows its Bash tool's `cd`; only a fresh launch names a new folder.
  const isClaudeLaunch =
    source === 'claude' &&
    hookPayload.hook_event_name === 'SessionStart' &&
    hookPayload.source === 'startup'
  return previousCwd && !isClaudeLaunch ? previousCwd : readPathFromKeys(hookPayload, ['cwd'])
}
