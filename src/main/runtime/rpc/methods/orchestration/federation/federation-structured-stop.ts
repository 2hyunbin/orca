import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { stopStructuredWorker } from '../../orchestration-structured-worker-lifecycle'

export async function stopRemoteStructuredAttachment(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  structured: StructuredWorkerIdentity
) {
  const db = runtime.getOrchestrationDb()
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  if (!resource || resource.ownership_state !== 'owned') {
    const attachment = db.markRemoteAttachmentStopUnknown(
      dispatchId,
      `The worker terminal is ${resource?.ownership_state ?? 'unproven'}; no worker was stopped.`
    )
    return {
      dispatchId,
      state: attachment.state,
      alreadySettled: false,
      processAction: 'none',
      lastError: attachment.last_error
    }
  }
  const stop = await stopStructuredWorker(structured, dispatchId, runtime).catch(
    (error: unknown) => ({
      stopped: false,
      closeAttempted: false,
      reason: error instanceof Error ? error.message : String(error)
    })
  )
  if (!stop.stopped) {
    const attachment = db.markRemoteAttachmentStopUnknown(
      dispatchId,
      stop.reason ?? 'The structured session close was not proven.'
    )
    return {
      dispatchId,
      state: attachment.state,
      alreadySettled: false,
      processAction: stop.closeAttempted ? 'closed_agent_terminal' : 'none',
      lastError: attachment.last_error
    }
  }
  const stopped = db.settleRemoteAttachmentStop(dispatchId)
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: stopped.state,
    alreadySettled: false,
    processAction: 'closed_agent_terminal'
  }
}
