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
