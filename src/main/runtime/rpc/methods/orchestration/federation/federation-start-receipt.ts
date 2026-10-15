import type { AgentLaunchResult } from '../../../../../../shared/agent-launch-intent'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { isFederationEffectUnknown } from './federation-effects'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'

export function failFederatedAttachmentWithReceipt(args: {
  db: OrchestrationDb
  dispatchId: string
  runtimeEpoch: string
  failedStage: string
  error: unknown
  setup: WorkerSetupReceipt
  launch: OrchestrationWorkerLaunchReceipt
  mode?: AgentLaunchResult['receipt']
  agentSession?: AgentLaunchResult['outcome']
  discardedSessionHandle?: string
}): unknown {
  const reason = args.error instanceof Error ? args.error.message : String(args.error)
  const unknown = isFederationEffectUnknown(args.error, args.failedStage)
  if (args.discardedSessionHandle) {
    const current = args.db.getRemoteDispatchAttachment(args.dispatchId)
    const residualResources: { id?: string }[] = JSON.parse(current?.residual_resources ?? '[]')
    args.db.recordRemoteAttachmentStage({
      dispatchId: args.dispatchId,
      stage: args.failedStage,
      residualResources: residualResources.filter(({ id }) => id !== args.discardedSessionHandle)
    })
  }
  const attachment = args.db.failRemoteAttachment(
    args.dispatchId,
    args.failedStage,
    reason,
    unknown
  )
  return {
    dispatchId: args.dispatchId,
    state: attachment.state === 'start_unknown' ? 'outcome_unknown' : attachment.state,
    stage: attachment.stage,
    runtimeEpoch: args.runtimeEpoch,
    failedStage: args.failedStage,
    lastError: reason,
    setup: args.setup,
    launch: args.launch,
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.agentSession
      ? { agentSession: args.agentSession, terminalHandle: args.agentSession.handle }
      : {}),
    effects: JSON.parse(attachment.effects) as unknown[],
    residualResources: JSON.parse(attachment.residual_resources) as unknown[]
  }
}
