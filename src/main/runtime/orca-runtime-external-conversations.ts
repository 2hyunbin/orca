import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { installExternalConversations } from '../external-conversations/external-conversations-install'
import { OrcaRuntimeWithAgentTransitions } from './orca-runtime-agent-transitions'

/** Owns the connector seam's on/off lifecycle; sits above the transition detector it will read. */
export abstract class OrcaRuntimeWithExternalConversations extends OrcaRuntimeWithAgentTransitions {
  private readonly externalConversations = installExternalConversations(this.store)

  /** The connector seam while connectors are on; null means every connector call is refused. */
  getExternalConversationSeam(): ExternalConversationSeam | null {
    return this.externalConversations.current()
  }
}
