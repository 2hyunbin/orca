import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { resolveStructuredWorkerIdentity } from '../../../../structured-worker-authority'
import { isStructuredWorkerHandle } from '../../../../structured-worker-identity'
import type { inspectRemoteAttachment } from './federation-attachment-observation'

export function remoteAttachmentLeaseIsCurrent(
  runtime: WorkerTerminalReleaseRuntime,
  attachment: RemoteDispatchAttachmentRow,
  observation: Awaited<ReturnType<typeof inspectRemoteAttachment>>,
  resource: WorkerTerminalResourceRow
): boolean {
  const db = runtime.getOrchestrationDb()
  const structured = isStructuredWorkerHandle(resource.terminal_handle)
    ? resolveStructuredWorkerIdentity(resource.terminal_handle, db)
    : null
  return Boolean(
    observation.exact &&
    (structured
      ? observation.structured?.handle === resource.terminal_handle &&
        resource.host_scope === JSON.stringify(structured.hostScope)
      : observation.terminal?.handle === resource.terminal_handle) &&
    attachment.terminal_handle === resource.terminal_handle &&
    resource.owner_dispatch_id === attachment.dispatch_id &&
    resource.ownership_state === 'owned' &&
    db.isRemoteAttachmentProcessCurrent({
      dispatchId: attachment.dispatch_id,
      paneKey: structured?.paneKey ?? runtime.getTerminalPaneKey(resource.terminal_handle),
      processIncarnation:
        structured?.processIncarnation ??
        runtime.getTerminalProcessIncarnation(resource.terminal_handle)
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}
