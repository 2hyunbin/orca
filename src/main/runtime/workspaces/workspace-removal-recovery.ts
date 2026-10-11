import type { RuntimeStore } from '../runtime-store-contract'
import type { RemoveManagedWorktreeOptions } from '../runtime-worktree-selection'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  resumeInterruptedWorktreeRemovals,
  retryFailedWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from '../../worktree-background-removal'
import { interruptedLocalWorktreeRemovalJob } from '../runtime-interrupted-local-worktree-removal'
import { retryFailedRemovalUnlessRegistered } from '../../worktree-removal-table'
import { invalidateAuthorizedRootsCacheForRepo } from '../../ipc/filesystem-auth'
import type { WorkspaceRemovalHost } from './workspace-removal-ports'

type WorkspaceRemovalRecoveryHost = Pick<
  WorkspaceRemovalHost,
  | 'getStore'
  | 'getPreservedBranchCleanup'
  | 'getAcquireFileWatcherRemoval'
  | 'purgeRemovedWorktree'
  | 'closeFileWatchersForRemoval'
  | 'stopPtysForDestructiveWorktreeRemoval'
  | 'emitWorktreeLifecycle'
  | 'publishWorktreeRemovalChange'
  | 'clearOptimisticReconcileToken'
  | 'removeWorktreeMetadataAndHistory'
  | 'invalidateResolvedWorktreeCache'
  | 'invalidateWorktreeScanCacheForRepo'
> & {
  localRemovalJobHost(store: RuntimeStore): Parameters<typeof interruptedLocalWorktreeRemovalJob>[1]
}

export class RuntimeWorkspaceRemovalRecovery {
  constructor(private readonly host: WorkspaceRemovalRecoveryHost) {}
  private get store() {
    return this.host.getStore()
  }
  finishInterruptedWorktreeRemovals(): void {
    const store = this.store
    if (!store) {
      return
    }
    resumeInterruptedWorktreeRemovals((record) =>
      interruptedLocalWorktreeRemovalJob(record, this.host.localRemovalJobHost(store))
    )
  }

  joinPendingWorktreeRemoval(
    worktreeId: string,
    options: RemoveManagedWorktreeOptions
  ): Promise<RemoveWorktreeResult> | undefined {
    return waitForPendingWorktreeRemoval(worktreeId, parseExecutionHostId(options.hostId)?.id)
  }

  retryFailedLocalRemoval(
    route: { kind: string },
    target: { id: string; path: string },
    registeredWorktrees: readonly GitWorktreeInfo[],
    options: RemoveManagedWorktreeOptions
  ): boolean {
    const store = this.store
    if (route.kind !== 'local' || !store) {
      return false
    }
    const hostId = parseExecutionHostId(options.hostId)?.id
    const allowUnverifiedPtyStop = options.allowUnverifiedPtyStop === true
    return retryFailedRemovalUnlessRegistered(target.id, target.path, registeredWorktrees, () =>
      retryFailedWorktreeRemoval(target.id, hostId, (record) =>
        interruptedLocalWorktreeRemovalJob(record, {
          ...this.host.localRemovalJobHost(store),
          stopPtys: () =>
            this.host.stopPtysForDestructiveWorktreeRemoval(record.worktreeId, {
              allowUnverifiedStop: allowUnverifiedPtyStop
            })
        })
      )
    )
  }

  localRemovalJobHost(
    store: RuntimeStore
  ): Parameters<typeof interruptedLocalWorktreeRemovalJob>[1] {
    return {
      store,
      acquireWatcherRemoval: this.host.getAcquireFileWatcherRemoval(),
      closeWatchers: (path) => this.host.closeFileWatchersForRemoval(path),
      preservedBranchCleanup: this.host.getPreservedBranchCleanup(),
      purge: ({ worktreeId, repoId }) =>
        this.host.purgeRemovedWorktree(store, worktreeId, repoId, LOCAL_EXECUTION_HOST_ID),
      onRemoved: ({ worktreeId, worktreePath }) =>
        this.host.emitWorktreeLifecycle({ kind: 'removed', worktreeId, path: worktreePath }),
      publish: (repoId) => this.host.publishWorktreeRemovalChange(repoId)
    }
  }

  purgeRemovedWorktree(
    store: RuntimeStore,
    worktreeId: string,
    repoId: string,
    removalHostId?: ExecutionHostId
  ): void {
    this.host.clearOptimisticReconcileToken(worktreeId)
    this.host.removeWorktreeMetadataAndHistory(store, worktreeId, removalHostId)
    this.host.invalidateResolvedWorktreeCache()
    this.host.invalidateWorktreeScanCacheForRepo(repoId)
    invalidateAuthorizedRootsCacheForRepo(store, repoId)
  }
}
