import type { AcpStructuredLane, AcpStructuredLaneDeps } from './acp-structured-lane'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { StructuredAgentSessionChildWorkProducer } from '../native-chat/agent-session-wire/structured-agent-session-subagent-rows'

export function acpLaneChildWorkDelivery(
  deps: AcpStructuredSessionAdapterDeps,
  sessionId: string,
  producer?: StructuredAgentSessionChildWorkProducer,
  lane?: () => AcpStructuredLane
): Pick<AcpStructuredLaneDeps, 'onChildWorkEvidence' | 'onChildWorkFailure'> {
  return {
    onChildWorkEvidence: (evidence) =>
      deps.onChildWorkEvidence?.(
        sessionId,
        evidence,
        producer && lane
          ? {
              ...producer,
              continueWork: (append) => lane().continueWork(append),
              written: () => lane().written()
            }
          : producer
      ),
    onChildWorkFailure: (error) =>
      deps.logger?.error('publishing ACP child work failed', {
        scope: 'acp-child-work',
        sessionId,
        error
      })
  }
}
