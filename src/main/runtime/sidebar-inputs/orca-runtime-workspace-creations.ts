import { OrcaRuntimeWithWorkspaceActivityFacts } from './orca-runtime-workspace-activity-facts'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime-managed-worktree-create-types'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { WorkspaceCreationsSnapshot } from '../../../shared/sidebar-list/workspace-creations'
import { WorkspaceCreationRegistry } from './workspace-creation-registry'

/**
 * Lists every runtime create (phone, CLI, agents, paired clients, orchestration) in the registry
 * the window's own IPC creates are listed in, and names the workspace the moment it is persisted.
 */
export abstract class OrcaRuntimeWithWorkspaceCreations extends OrcaRuntimeWithWorkspaceActivityFacts {
  readonly workspaceCreations = new WorkspaceCreationRegistry()

  getWorkspaceCreations(): WorkspaceCreationsSnapshot {
    return this.workspaceCreations.snapshot()
  }

  override async createManagedWorktree(
    args: RuntimeManagedWorktreeCreateArgs
  ): Promise<CreateWorktreeResult> {
    // A selector naming no project has nothing to list; the create itself reports why.
    const repo = await this.resolveRepoSelector(args.repoSelector).catch(() => null)
    if (!repo) {
      return super.createManagedWorktree(args)
    }
    return this.workspaceCreations.track(
      { creationId: args.creationId, repoId: repo.id },
      (named) =>
        super.createManagedWorktree({
          ...args,
          onWorkspaceCreated: (worktreeId) => {
            named(worktreeId)
            args.onWorkspaceCreated?.(worktreeId)
          }
        })
    )
  }
}
