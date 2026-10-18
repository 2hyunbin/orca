import type { ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import type { AppState } from '@/store/types'

type PreviousActive = { worktreeId: string | null; hostId: ExecutionHostId | null }

export function readPreviousActive(state: AppState): PreviousActive {
  return { worktreeId: state.activeWorktreeId, hostId: state.activeWorkspaceExecutionHostId }
}

/** Stamps focus recency for the workspace being opened. */
export function markVisited(state: AppState, workspaceId: string, previous: PreviousActive): void {
  // Switch point: terminals no longer stamp Recent, so leaving a workspace marks it used up to now.
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    state.markWorktreeVisited(workspaceId)
    return
  }
  const visitedAt = Date.now()
  if (previous.worktreeId && previous.worktreeId !== workspaceId) {
    state.markWorktreeVisited(previous.worktreeId, visitedAt - 1, previous.hostId ?? undefined)
  }
  state.markWorktreeVisited(workspaceId, visitedAt)
}
