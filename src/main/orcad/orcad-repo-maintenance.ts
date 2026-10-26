import type { RuntimeRpcClientActivity } from '../runtime/runtime-rpc/runtime-rpc-shutdown'
import { installRepoMaintenanceHostIdleGate } from '../repo-maintenance-host-idle-gate'
import { REF_MAINTENANCE_QUIET_PERIOD_MS } from '../../shared/repo-ref-maintenance-policy'

export function installOrcadRepoMaintenance(
  rpc: { readClientActivity(): RuntimeRpcClientActivity },
  agents: { hasWorkingAgent(): boolean },
  store: { hasStagedOrcadMigrationCatalog(): boolean }
): () => Promise<void> {
  let stopping = false
  const uninstall = installRepoMaintenanceHostIdleGate({
    isQuitting: () => stopping,
    getWorkingAgentCount: () => (agents.hasWorkingAgent() ? 1 : 0),
    isBusy: () => {
      const activity = rpc.readClientActivity()
      return (
        activity.requestsInFlight > 0 ||
        !Number.isFinite(activity.lastRequestAt) ||
        Date.now() - activity.lastRequestAt < REF_MAINTENANCE_QUIET_PERIOD_MS ||
        store.hasStagedOrcadMigrationCatalog()
      )
    }
  })
  return () => {
    stopping = true
    return uninstall()
  }
}
