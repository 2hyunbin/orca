import type { ClaudeStructuredSessionAdapterDeps } from '../claude/claude-structured-session-adapter'
import type { CodexStructuredSessionAdapterDeps } from '../codex/codex-structured-session-adapter'
import type { StructuredAgentSessionStartupLimits } from '../native-chat/agent-session-wire/structured-agent-session-startup-attempt-contract'
import type { PiRpcSessionDeps } from '../pi/rpc-session'

/** Provider transports are overridden only to drive the runtime against scripted children. */
export type StructuredAgentSessionTransportOverrides = {
  openPiConnection?: PiRpcSessionDeps['openConnection']
  openCodexConnection?: CodexStructuredSessionAdapterDeps['openConnection']
  openClaudeConnection?: ClaudeStructuredSessionAdapterDeps['openConnection']
  /** Scripted app-servers carry fake pids the real start-time read cannot answer for. */
  readProcessStartTime?: CodexStructuredSessionAdapterDeps['readProcessStartTime']
  /** The shipped startup limits unless a test shortens them. */
  startupLimits?: Partial<StructuredAgentSessionStartupLimits>
}
