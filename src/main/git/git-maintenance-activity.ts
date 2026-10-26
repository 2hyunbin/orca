import type { GitMaintenanceActivity } from '../../shared/process-stats-types'

const running = new Set<GitMaintenanceActivity>()
let snapshot: readonly GitMaintenanceActivity[] = []

function startGitMaintenanceActivity(activity: GitMaintenanceActivity): () => void {
  running.add(activity)
  snapshot = [...running]
  return () => {
    if (running.delete(activity)) {
      snapshot = [...running]
    }
  }
}

export function readGitMaintenanceActivity(): readonly GitMaintenanceActivity[] {
  return snapshot
}

export function observeGitMaintenanceChild(
  repoPath: string,
  phase: GitMaintenanceActivity['phase'] | undefined,
  onTerminated: () => void
): { onChildSpawned: () => void; onChildTerminated: () => void } | undefined {
  if (!phase) {
    return undefined
  }
  let finish: (() => void) | undefined
  return {
    onChildSpawned: () => {
      finish = startGitMaintenanceActivity({ repoPath, phase })
    },
    onChildTerminated: () => {
      finish?.()
      onTerminated()
    }
  }
}
