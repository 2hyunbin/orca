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
  // Keep the session's first folder: Claude's hook cwd follows its Bash tool's `cd`.
  const previous = state.lastStatusByPaneKey.get(paneKey)?.providerSession
  const cwd =
    previous?.id === providerSession.id && previous.cwd
      ? previous.cwd
      : readPathFromKeys(hookPayload, ['cwd'])
  return cwd ? { ...providerSession, cwd } : providerSession
}
