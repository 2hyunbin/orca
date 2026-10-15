import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { structuredWorkerAgent } from '../../../../structured-worker-authority'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { readStructuredWorkerJournal } from '../../orchestration-structured-worker-lifecycle'
import { inspectRemoteAttachment } from './federation-attachment-observation'

export async function readRemoteStructuredOutput(args: {
  runtime: OrcaRuntimeService
  attachment: RemoteDispatchAttachmentRow
  structured: StructuredWorkerIdentity
  liveness: 'live' | 'exited' | 'unverifiable'
  source?: 'auto' | 'transcript' | 'terminal'
  cursor?: string | number
  limit?: number
}) {
  const { runtime, attachment, structured } = args
  if (args.source === 'terminal') {
    throw new OrchestrationError(
      'archive_unavailable',
      `Worker Dispatch ${attachment.dispatch_id} has no terminal output; read it with --source auto or --source transcript.`
    )
  }
  const output = await readStructuredWorkerJournal({
    identity: structured,
    dispatchId: attachment.dispatch_id,
    workerState: attachment.state,
    liveness: args.liveness,
    agent: structuredWorkerAgent(structured),
    cursor: args.cursor,
    limit: args.limit
  })
  const afterRead = await inspectRemoteAttachment(runtime, attachment.dispatch_id)
  if (!afterRead.exact) {
    throw new OrchestrationError(
      'worker_identity_changed',
      `Remote Dispatch ${attachment.dispatch_id} changed process while output was read.`
    )
  }
  return { dispatchId: attachment.dispatch_id, runtimeEpoch: runtime.getRuntimeId(), output }
}
