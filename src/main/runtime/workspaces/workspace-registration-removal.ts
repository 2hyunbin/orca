import { splitWorktreeId, splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { invalidateAuthorizedRootsCache } from '../../ipc/filesystem-auth'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeStore } from '../runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from '../runtime-worktree-selection'
import type {
  WorkspaceRegistrationRemovalHost,
  WorkspaceRemovalContext
} from './workspace-removal-ports'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getRuntimeFolderWorkspaceRootId } from '../runtime-folder-workspace'

export async function removeOrphanOrFolderWorktree({
  runtime,
  store,
  removalTarget,
  cleanupHostId,
  context
}: {
  runtime: WorkspaceRegistrationRemovalHost
  store: RuntimeStore
  removalTarget: RuntimeWorktreeRemovalTarget
  cleanupHostId?: ExecutionHostId
  context: WorkspaceRemovalContext
}): Promise<
  | { kind: 'removed'; result: { warning?: string } }
  | { kind: 'git'; repo: Repo; removalHostId: ExecutionHostId }
> {
  const { repo, removalHostId } = context
  if (!repo) {
    const orphanHost = parseExecutionHostId(store.getWorktreeMeta(removalTarget.id)?.hostId)
    if (cleanupHostId && orphanHost?.id !== cleanupHostId) {
      throw new Error(
        `Workspace identity for ${removalTarget.id} no longer belongs to ${cleanupHostId}. Refresh projects and try again.`
      )
    }
    const ptyProvider = runtime.getLocalProvider()
    const externalOrphanHost = orphanHost?.kind === 'ssh' || orphanHost?.kind === 'runtime'
    if (ptyProvider) {
      await runtime
        .killOrphanWorktreeProcesses(removalTarget.id, {
          resolvedWorktreeId: removalTarget.id,
          ...(orphanHost?.kind === 'ssh' ? { resolvedConnectionId: orphanHost.targetId } : {}),
          ...(orphanHost?.kind === 'runtime'
            ? { resolvedRuntimeEnvironmentId: orphanHost.environmentId }
            : {}),
          localProvider: ptyProvider,
          onPtyStopped: runtime.getOnPtyStopped() ?? undefined,
          // A structured session is on no PTY surface, so the sweeps above leave it attached to a
          // workspace this removal is about to forget. Closed best-effort, exactly like those PTYs.
          closeStructuredSessions: true,
          ...(externalOrphanHost
            ? { includeProviderInventory: false, includeLocalRegistry: false }
            : {})
        })
        .catch((error) => {
          console.warn(`[worktree-teardown] orphan cleanup failed for ${removalTarget.id}:`, error)
        })
    }
    const orphanFullPath = splitWorktreeId(removalTarget.id)?.worktreePath
    const orphanWatcherPath =
      splitWorktreeIdForFilesystem(removalTarget.id)?.worktreePath === orphanFullPath
        ? orphanFullPath
        : undefined
    if (orphanWatcherPath) {
      await runtime
        .acquireFileWatcherRemoval(
          orphanWatcherPath,
          orphanHost?.kind === 'ssh' ? orphanHost.targetId : undefined
        )
        .then((gate) => gate.finish(false))
        .catch(() => {})
    }
    runtime.clearOptimisticReconcileToken(removalTarget.id)
    runtime.removeWorktreeMetadataAndHistory(
      store,
      removalTarget.id,
      cleanupHostId ?? orphanHost?.id
    )
    runtime.getPreservedBranchCleanup().delete(removalTarget.id, cleanupHostId)
    runtime.invalidateResolvedWorktreeCache()
    runtime.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
    invalidateAuthorizedRootsCache()
    runtime.notifyWorktreesChanged(removalTarget.repoId)
    return {
      kind: 'removed',
      result: {
        warning: `Project ${removalTarget.repoId} is no longer tracked, so ${removalTarget.path} was forgotten without deleting the directory or its Git worktree registration.`
      }
    }
  }

  if (!isFolderRepo(repo)) {
    return { kind: 'git', ...context }
  }
  if (removalTarget.id === getRuntimeFolderWorkspaceRootId(repo)) {
    throw new Error('Cannot delete the project root workspace. Remove the folder project instead.')
  }
  // Resolved, not raw: a folder repo naming its owner only as `executionHostId: 'ssh:*'` used to
  // tear down its PTYs and history on the client. A `runtime:` host answers null — its nested
  // target is addressable only inside that environment, never from this client's SSH table.
  const folderHost = parseExecutionHostId(removalHostId)
  const folderConnectionId = folderHost?.kind === 'ssh' ? folderHost.targetId : null
  await runtime.teardownFolderWorkspacePtys(removalTarget.id, folderConnectionId)
  runtime.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
  runtime.getPreservedBranchCleanup().delete(removalTarget.id, cleanupHostId)
  runtime.invalidateResolvedWorktreeCache()
  runtime.notifyWorktreesChanged(repo.id)
  return { kind: 'removed', result: {} }
}
