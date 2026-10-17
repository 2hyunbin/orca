import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'

export type MobileStructuredAgentOptionsInput = {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  fence: number | null
  mutate: StructuredAgentSessionMutate
  /** Moves when the host's status says a session option changed; each move re-reads them. */
  optionStamp?: string
  /** What the host advertised; null until its status probe answers. */
  hostSupport: Pick<StructuredAgentSessionHostSupport, 'sendOptions' | 'permissionModes'> | null
  hostSelection?: Readonly<Record<string, string>>
  hostPermissionMode?: string
}
