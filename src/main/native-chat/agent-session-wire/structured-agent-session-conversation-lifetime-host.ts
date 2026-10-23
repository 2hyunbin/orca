import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export type StructuredAgentSessionConversationLifetimeHost = {
  /** Resolved per call: the host's collaborators are assigned after this is built. */
  context: () => StructuredAgentSessionLifetimeContext
  sessions: StructuredAgentSessionConversations
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** PR 1's one open function, for a caller inside the session's serialize. */
  open: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  deliveryActive: (sessionId: string) => boolean
  /** The handle closed: `listed` keeps the chat's row in the agent-status store for its tab. */
  closeStatus: (sessionId: string, options: { listed: boolean }) => void
  /** Child work the provider reported running and not over, recorded or not. */
  childWorkOpen: (sessionId: string) => boolean
}
