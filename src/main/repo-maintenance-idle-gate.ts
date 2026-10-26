import { app, powerMonitor } from 'electron'
import { REF_MAINTENANCE_QUIET_PERIOD_MS } from '../shared/repo-ref-maintenance-policy'
import { postponeRepoRefMaintenance } from './git/local-repo-ref-maintenance'
import {
  installRepoMaintenanceHostIdleGate,
  type RepoMaintenanceIdleInputs
} from './repo-maintenance-host-idle-gate'

export type { RepoMaintenanceIdleInputs } from './repo-maintenance-host-idle-gate'

export function installRepoMaintenanceIdleGate(
  inputs: RepoMaintenanceIdleInputs
): () => Promise<void> {
  const uninstallHostGate = installRepoMaintenanceHostIdleGate({
    ...inputs,
    isBusy: () => (inputs.isBusy?.() ?? false) || isOnBatteryPower() || isUserRecentlyActive()
  })
  // Postpone future packs; killing one in flight can strand a ref lock.
  const onBattery = (): void => {
    postponeRepoRefMaintenance()
  }
  const onFocus = (): void => {
    postponeRepoRefMaintenance()
  }
  powerMonitor.on('on-battery', onBattery)
  app.on('browser-window-focus', onFocus)
  return () => {
    app.off('browser-window-focus', onFocus)
    powerMonitor.off('on-battery', onBattery)
    return uninstallHostGate()
  }
}

function isOnBatteryPower(): boolean {
  try {
    return powerMonitor.isOnBatteryPower()
  } catch {
    // An unavailable power API is not evidence of battery use.
    return false
  }
}

function isUserRecentlyActive(): boolean {
  try {
    return powerMonitor.getSystemIdleTime() * 1000 < REF_MAINTENANCE_QUIET_PERIOD_MS
  } catch {
    return true
  }
}
