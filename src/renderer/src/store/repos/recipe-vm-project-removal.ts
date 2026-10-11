import { isRuntimeOwnedSshTargetId, type ExecutionHostId } from '../../../../shared/execution-host'
import { cleanupEphemeralVmRuntimesForDeleted } from '@/lib/ephemeral-vm-runtime-cleanup'
import { getRecipeVmSshTargetForHost } from '@/lib/recipe-vm-managed-host'

/**
 * Destroys the recipe VM behind a project before the project is removed, so it never leaks.
 * Resolves true when the project lived on the VM's managed server, which the VM took with it.
 */
export async function destroyRecipeVmBeforeProjectRemoval(args: {
  runtimeEnvironments: Parameters<typeof getRecipeVmSshTargetForHost>[0]
  ownerHostId: ExecutionHostId
  connectionId: string | null | undefined
  workspaceIds: string[]
}): Promise<boolean> {
  const vmServerSshTargetId = getRecipeVmSshTargetForHost(
    args.runtimeEnvironments,
    args.ownerHostId
  )
  const targetId = vmServerSshTargetId ?? args.connectionId
  // Why: an SSH per-workspace-env's workspace is the repo's main worktree, so removal routes here.
  if (!targetId || !isRuntimeOwnedSshTargetId(targetId)) {
    return false
  }
  // Why host-scoped: another VM's server can publish the same raw workspace id.
  const cleanup = await cleanupEphemeralVmRuntimesForDeleted({
    hostScopedWorkspaces: args.workspaceIds.map((workspaceId) => ({
      workspaceId,
      executionHostId: args.ownerHostId
    })),
    runtimeOwnedSshTargetIds: [targetId]
  })
  if (cleanup.retainedSshTargetIds.includes(targetId)) {
    throw new Error('The cloud VM could not be destroyed. Retry cleanup before removing it.')
  }
  return vmServerSshTargetId !== null
}
