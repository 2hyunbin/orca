import {
  disposeLocalRepoRefMaintenance,
  setRepoMaintenanceActivityProbe
} from './git/local-repo-ref-maintenance'
import { hasWorktreeRemovalsInFlight } from './ipc/worktrees/worktree-ipc-context'
import { hasPendingWorktreeCreatePreparations } from './worktree-create-preparation'
import { hasPendingWorktreeRemovals } from './worktree-removal-table'

export type RepoMaintenanceIdleInputs = {
  isQuitting: () => boolean
  getWorkingAgentCount: () => number
  isBusy?: () => boolean
}

/** The execution host owns activity and disposal, independently of connected clients. */
export function installRepoMaintenanceHostIdleGate(
  inputs: RepoMaintenanceIdleInputs
): () => Promise<void> {
  setRepoMaintenanceActivityProbe(
    () =>
      inputs.isQuitting() ||
      inputs.getWorkingAgentCount() > 0 ||
      hasPendingWorktreeCreatePreparations() ||
      hasWorktreeRemovalsInFlight() ||
      hasPendingWorktreeRemovals() ||
      (inputs.isBusy?.() ?? false)
  )
  return () => {
    const stopped = disposeLocalRepoRefMaintenance()
    setRepoMaintenanceActivityProbe(null)
    return stopped
  }
}
