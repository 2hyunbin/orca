import type { ConnectorProject } from '../../shared/connector-cloud-contract'
import type {
  ExternalConversationHost,
  ExternalConversationSeam
} from '../external-conversations/external-conversation-seam'
import type { ConnectorHostSession } from './connector-host-session'

/** What the connector needs from this Orca; the seam exists exactly while connectors are on. */
export type ConnectorMachine = {
  runtime: 'serve' | 'desktop'
  orcaVersion: string
  seam: () => ExternalConversationSeam | null
  conversationHost: () => ExternalConversationHost
  agents: () => string[]
  projects: () => ConnectorProject[]
  onConnectorsToggled: (listener: () => void) => void
}

/** How the client reaches the cloud as this machine; the credential behind it can change. */
export type ConnectorTransport = Pick<ConnectorHostSession, 'current' | 'call'>
