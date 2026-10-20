import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { StoreRuntimeState } from './store-runtime-state'

export function markPtyBindingSessionDirty(
  runtime: Pick<StoreRuntimeState, 'dirtyProfileStateDomains'>,
  hostId: ExecutionHostId
): void {
  runtime.dirtyProfileStateDomains?.add(
    hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
  )
}
