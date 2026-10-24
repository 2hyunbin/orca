import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { ParsedAgentStatusPayload } from './agent-status-types'

type PaneCodexRow = {
  payload: Pick<ParsedAgentStatusPayload, 'agentType' | 'state'>
  providerSession?: Pick<AgentProviderSessionMetadata, 'id' | 'transcriptPath'>
}

export type IncomingCodexThread = {
  sessionId: string | undefined
  /** False only when Codex reported no rollout (`transcript_path: null`), as for a /side fork. */
  hasRollout: boolean
  /** A SessionStart that opens a new conversation (not a fork); undefined when the receiver cannot
   *  tell, as for relayed hooks, which carry no SessionStart source. */
  newConversation: boolean | undefined
}

/**
 * Whether a Codex root hook comes from an ephemeral thread that is not the pane's own thread, such
 * as a /side fork, which shares the pane but must not move its status. Keyed on the stored row, not
 * on transient caches, so it holds across an Orca or relay restart.
 */
export function isForeignEphemeralCodexThread(
  pane: PaneCodexRow | undefined,
  incoming: IncomingCodexThread
): boolean {
  const thread = pane?.payload.agentType === 'codex' ? pane.providerSession : undefined
  if (
    !thread?.id ||
    !thread.transcriptPath ||
    !incoming.sessionId ||
    incoming.sessionId === thread.id ||
    incoming.hasRollout ||
    incoming.newConversation === true
  ) {
    return false
  }
  // Why: without the SessionStart source, only a running turn proves the pane still has its thread.
  return incoming.newConversation === false || pane?.payload.state !== 'done'
}

/** The thread a raw Codex hook payload reports; undefined for a child (subagent) hook. */
export function codexHookThread(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): IncomingCodexThread | undefined {
  if (typeof hookPayload.agent_id === 'string' && hookPayload.agent_id) {
    return undefined
  }
  const source = typeof hookPayload.source === 'string' ? hookPayload.source : undefined
  return {
    sessionId: typeof hookPayload.session_id === 'string' ? hookPayload.session_id : undefined,
    hasRollout: hookPayload.transcript_path !== null,
    newConversation:
      eventName !== 'SessionStart' ? false : source === undefined ? undefined : source !== 'fork'
  }
}
