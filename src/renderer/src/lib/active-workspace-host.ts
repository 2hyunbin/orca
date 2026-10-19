import type { ExecutionHostId } from '../../../shared/execution-host'

/** The host the user selected for `worktreeId` when it is the active workspace; else null. */
export function getActiveWorkspaceExecutionHostId(
  state: {
    activeWorktreeId?: string | null
    activeWorkspaceExecutionHostId?: ExecutionHostId | null
  },
  worktreeId: string
): ExecutionHostId | null {
  return state.activeWorktreeId === worktreeId
    ? (state.activeWorkspaceExecutionHostId ?? null)
    : null
}

/** Re-selects `worktreeId`; when it is already active, keeps the selected copy of a same-id twin. */
export function reselectWorkspaceKeepingHost(
  state: Parameters<typeof getActiveWorkspaceExecutionHostId>[0] & {
    setActiveWorktree: (worktreeId: string, executionHostId?: ExecutionHostId) => unknown
  },
  worktreeId: string
): void {
  const hostId = getActiveWorkspaceExecutionHostId(state, worktreeId)
  if (hostId) {
    state.setActiveWorktree(worktreeId, hostId)
  } else {
    state.setActiveWorktree(worktreeId)
  }
}
