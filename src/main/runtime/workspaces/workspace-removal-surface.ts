import { OrcaRuntimeWithCreateManagedRemoteWorktree } from '../orca-runtime-create-managed-remote-worktree'
import type { RuntimeWorkspaceRemoval } from './workspace-removal'

export class RuntimeWorkspaceRemovalSurface extends OrcaRuntimeWithCreateManagedRemoteWorktree {
  removeManagedWorktree(
    ...args: Parameters<RuntimeWorkspaceRemoval['removeManagedWorktree']>
  ): ReturnType<RuntimeWorkspaceRemoval['removeManagedWorktree']> {
    return this.workspaceRemoval.removeManagedWorktree(...args)
  }
}
