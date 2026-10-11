import type { RuntimeStore } from '../runtime-store-contract'
import type { Repo } from '../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { IPtyProvider } from '../../providers/types'
import type { WorktreeTeardownDeps, WorktreeTeardownResult } from '../worktree-teardown'
import type { RuntimePreservedBranchCleanup } from '../runtime-preserved-branch-cleanup'
import type { RuntimeWorktreeLifecycleEvent } from '../orca-runtime-core'
import type {
  RemoveManagedWorktreeOptions,
  RuntimeWorktreeRemovalTarget
} from '../runtime-worktree-selection'

export type WorkspaceRemovalContext =
  | { readonly repo: Repo; readonly removalHostId: ExecutionHostId }
  | { readonly repo: undefined; readonly removalHostId: ExecutionHostId | undefined }

type WatcherRemovalGate = { finish(removed: boolean): Promise<void> }

export type WorkspaceRegistrationRemovalHost = {
  getLocalProvider(): IPtyProvider | null
  getOnPtyStopped(): ((ptyId: string) => void) | null
  killOrphanWorktreeProcesses(
    worktreeId: string,
    deps: Omit<WorktreeTeardownDeps, 'runtime'>
  ): Promise<WorktreeTeardownResult>
  teardownFolderWorkspacePtys(worktreeId: string, connectionId: string | null): Promise<void>
  acquireFileWatcherRemoval(path: string, connectionId?: string): Promise<WatcherRemovalGate>
  clearOptimisticReconcileToken(worktreeId: string): void
  removeWorktreeMetadataAndHistory(
    store: RuntimeStore,
    worktreeId: string,
    hostId?: ExecutionHostId
  ): void
  getPreservedBranchCleanup(): Pick<
    RuntimePreservedBranchCleanup,
    'delete' | 'remember' | 'preserveHead'
  >
  invalidateResolvedWorktreeCache(): void
  invalidateWorktreeScanCacheForRepo(repoId: string): void
  notifyWorktreesChanged(repoId: string): void
}

export type WorkspaceRemovalHost = WorkspaceRegistrationRemovalHost & {
  getAcquireFileWatcherRemoval(): WorkspaceRegistrationRemovalHost['acquireFileWatcherRemoval']
  getStore(): RuntimeStore | null
  requireStore(): RuntimeStore
  resolveWorktreeRemovalTarget(
    selector: string,
    requiredHostId?: ExecutionHostId
  ): Promise<RuntimeWorktreeRemovalTarget>
  joinPendingWorktreeRemoval(
    worktreeId: string,
    options: RemoveManagedWorktreeOptions
  ): Promise<RemoveWorktreeResult> | undefined
  emitWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void
  purgeRemovedWorktree(
    store: RuntimeStore,
    worktreeId: string,
    repoId: string,
    hostId?: ExecutionHostId
  ): void
  retryFailedLocalRemoval(
    route: { kind: string },
    target: Pick<RuntimeWorktreeRemovalTarget, 'id' | 'path'>,
    registered: readonly GitWorktreeInfo[],
    options: RemoveManagedWorktreeOptions
  ): boolean
  stopPtysForDestructiveWorktreeRemoval(
    worktreeId: string,
    options: { allowUnverifiedStop?: boolean }
  ): Promise<void>
  closeFileWatchersForRemoval(path: string): Promise<void>
  publishWorktreeRemovalChange(repoId: string): void
}
