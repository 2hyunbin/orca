import { app, BrowserWindow, powerMonitor } from 'electron'
import {
  disposeLocalRepoRefMaintenance,
  postponeRepoRefMaintenance,
  setRepoMaintenanceActivityProbe,
  setRepoObjectBacklogProbe
} from './git/local-repo-ref-maintenance'
import { hasWorktreeRemovalsInFlight } from './ipc/worktrees/worktree-ipc-context'
import { hasPendingWorktreeCreatePreparations } from './worktree-create-preparation'
import { hasPendingWorktreeRemovals } from './worktree-removal-table'

// pack-refs shares a ref lock with worktree deletion; defer while user work is active.
export type RepoMaintenanceIdleInputs = {
  isQuitting: () => boolean
  getWorkingAgentCount: () => number
}

export function installRepoMaintenanceIdleGate(
  inputs: RepoMaintenanceIdleInputs
): () => Promise<void> {
  setRepoMaintenanceActivityProbe(
    () =>
      inputs.isQuitting() ||
      inputs.getWorkingAgentCount() > 0 ||
      hasPendingWorktreeCreatePreparations() ||
      hasWorktreeRemovalsInFlight() ||
      hasPendingWorktreeRemovals() ||
      isOnBatteryPower()
  )
  // A first repack of a huge backlog runs for minutes; start it only while the user is away.
  setRepoObjectBacklogProbe(
    () =>
      !inputs.isQuitting() &&
      inputs.getWorkingAgentCount() === 0 &&
      !isOnBatteryPower() &&
      isUserAway()
  )
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
    // Stop armed timers before removing the activity probe.
    const stopped = disposeLocalRepoRefMaintenance()
    setRepoMaintenanceActivityProbe(null)
    setRepoObjectBacklogProbe(null)
    return stopped
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

const USER_AWAY_IDLE_SECONDS = 5 * 60

function isUserAway(): boolean {
  try {
    return (
      BrowserWindow.getFocusedWindow() === null ||
      powerMonitor.getSystemIdleTime() >= USER_AWAY_IDLE_SECONDS
    )
  } catch {
    return false
  }
}
