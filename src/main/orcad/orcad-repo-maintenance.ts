import type { RuntimeRpcClientActivity } from '../runtime/runtime-rpc/runtime-rpc-shutdown'
import { installRepoMaintenanceHostIdleGate } from '../repo-maintenance-host-idle-gate'

export function installOrcadRepoMaintenance(
  rpc: { readClientActivity(): RuntimeRpcClientActivity },
  agents: { getStatusSnapshot(): readonly { state: string }[] },
  store: { hasStagedOrcadMigrationCatalog(): boolean }
): () => Promise<void> {
  let stopping = false
  const uninstall = installRepoMaintenanceHostIdleGate({
    isQuitting: () => stopping,
    getWorkingAgentCount: () =>
      agents.getStatusSnapshot().filter((status) => status.state === 'working').length,
    isBusy: () =>
      rpc.readClientActivity().requestsInFlight > 0 || store.hasStagedOrcadMigrationCatalog()
  })
  return () => {
    stopping = true
    return uninstall()
  }
}
