import { clearRuntimeEnvironmentCapabilityEvidence } from '../ipc/runtime-environment-capability-evidence'
import { clearRuntimeEnvironmentManualDisconnect } from '../ipc/runtime-environment-manual-disconnect'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  forgetRemoteLayoutSnapshot,
  type RemoteLayoutSnapshotStore
} from '../remote-layout-snapshot'

/** What a removed server leaves in the profile. */
export type RemovedServerStore = RemoteLayoutSnapshotStore & {
  /** Drops the unlinked server's workspace session partition. */
  removeWorkspaceSessionHost: (hostId: ExecutionHostId) => void
}

export function retireRuntimeEnvironmentState(
  environmentId: string,
  invalidateTransport: (environmentId: string) => Promise<void> | void,
  store: RemovedServerStore
): Promise<void> {
  clearRuntimeEnvironmentCapabilityEvidence(environmentId)
  // Why: listings enumerate session partitions as known hosts, so a kept one names a dead server.
  store.removeWorkspaceSessionHost(toRuntimeExecutionHostId(environmentId))
  forgetRemoteLayoutSnapshot(store, environmentId)
  clearRuntimeEnvironmentManualDisconnect(environmentId)
  const retiring = Promise.resolve(invalidateTransport(environmentId))
  return retiring
}
