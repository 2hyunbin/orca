import {
  findWorkspaceFileRoute,
  type RuntimeWorkspaceFileRoute
} from '@/lib/runtime-workspace-file-route'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'

/** View other local/WSL/folder workspace files here read-only (#32158); SSH/server reads are workspace-relative, so open in the owning workspace and reuse its tab. */
export function siblingWorkspaceLink(
  executionHostId: ExecutionHostId,
  absolutePath: string,
  sourceWorktreeId: string
): { view: RuntimeWorkspaceFileRoute | null; openInOwner: RuntimeWorkspaceFileRoute | null } {
  // Why: floating-workspace files stay in their panel even when a project also contains the path.
  if (isFloatingWorkspaceId(sourceWorktreeId)) {
    return { view: null, openInOwner: null }
  }
  const found = findWorkspaceFileRoute(useAppStore.getState(), executionHostId, absolutePath)
  const owner = found && found.worktreeId !== sourceWorktreeId ? found : null
  return executionHostId === LOCAL_EXECUTION_HOST_ID
    ? { view: owner, openInOwner: null }
    : { view: null, openInOwner: owner }
}

/** A view here of another local workspace's file: this computer's file, never saved here. */
export function otherWorkspaceViewFields(owner: RuntimeWorkspaceFileRoute | null): {
  readOnly?: true
  runtimeEnvironmentId?: null
} {
  return owner ? { readOnly: true, runtimeEnvironmentId: null } : {}
}
