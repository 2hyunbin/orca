import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { isForeignEphemeralCodexThread } from '../../../shared/codex-ephemeral-thread'
import { isStaleGrokTurnEnd } from './server-grok-status-rules'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** A relayed hook from an ephemeral Codex thread (a /side fork) that the execution host let
 *  through, as a restarted relay, or one that predates its own check, does. */
function isRelayedForeignEphemeralCodexThread(
  previous: EnrichedAgentHookEventPayload,
  incoming: AgentHookEventPayload
): boolean {
  return (
    Boolean(incoming.connectionId) &&
    incoming.payload.agentType === 'codex' &&
    !incoming.toolAgentId &&
    isForeignEphemeralCodexThread(previous, {
      sessionId: incoming.providerSession?.id,
      hasRollout: Boolean(incoming.providerSession?.transcriptPath),
      newConversation: undefined
    })
  )
}

/** A hook that belongs to a turn other than the one the row tracks, so it must leave the row. */
export function isForeignTurnHook(
  previous: EnrichedAgentHookEventPayload,
  incoming: AgentHookEventPayload
): boolean {
  return (
    isStaleGrokTurnEnd(previous, incoming) ||
    isRelayedForeignEphemeralCodexThread(previous, incoming)
  )
}
