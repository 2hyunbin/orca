import type { ChildWorkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { AcpChildStops, AcpDialect } from './acp-dialects/acp-dialect'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

export type AcpStructuredLaneDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: string
  agentName: string
  generation: string
  providerSessionId: string
  dialect: AcpDialect
  logger: StructuredAgentSessionLogger
  /** First provider event confirms receipt of an Orca send. */
  onInputAccepted: (clientMessageId: string) => void
  /** Permanent sink refusal prevents further journaling. */
  onFailed: (reason: string) => void
  onChildWorkEvidence?: (evidence: AgentChildWorkEvidence[]) => ChildWorkAdmission | void
  onChildWorkFailure?: (error: unknown) => void
  now?: () => number
  childStops?: () => AcpChildStops
}
