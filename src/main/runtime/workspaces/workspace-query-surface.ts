import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type {
  WorktreeLineageInput,
  WorktreeLineageResolution
} from '../runtime-worktree-lineage-resolution'
import type { OrchestrationDb } from '../orchestration/db'
import { resolveNestedWorkerMaxDepth } from '../../../shared/nested-worker-depth'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeStore } from '../runtime-store-contract'
import { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../orca-runtime-resolve-browser-network-execution-host-for-worktree'
import type { RuntimeWorkspaceCatalog } from './workspace-catalog'
import type { RuntimeWorkspaceSelectors } from './workspace-selectors'
import type { RuntimeWorkspaceRepoScans } from './workspace-repo-scans'

export class RuntimeWorkspaceQuerySurface extends OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree {
  protected resolveWorktreeSelector(
    ...args: Parameters<RuntimeWorkspaceSelectors['resolveWorktreeSelector']>
  ): ReturnType<RuntimeWorkspaceSelectors['resolveWorktreeSelector']> {
    return this.workspaceQueries.selectors.resolveWorktreeSelector(...args)
  }

  protected selectReposBySelector(
    ...args: Parameters<RuntimeWorkspaceSelectors['selectReposBySelector']>
  ): ReturnType<RuntimeWorkspaceSelectors['selectReposBySelector']> {
    return this.workspaceQueries.selectors.selectReposBySelector(...args)
  }

  protected resolveRepoSelector(
    ...args: Parameters<RuntimeWorkspaceSelectors['resolveRepoSelector']>
  ): ReturnType<RuntimeWorkspaceSelectors['resolveRepoSelector']> {
    return this.workspaceQueries.selectors.resolveRepoSelector(...args)
  }

  protected buildResolvedWorktreeFromId(
    ...args: Parameters<RuntimeWorkspaceSelectors['buildResolvedWorktreeFromId']>
  ): ReturnType<RuntimeWorkspaceSelectors['buildResolvedWorktreeFromId']> {
    return this.workspaceQueries.selectors.buildResolvedWorktreeFromId(...args)
  }

  protected listKnownResolvedWorktreesForExplicitTarget(
    ...args: Parameters<RuntimeWorkspaceCatalog['listKnownResolvedWorktreesForExplicitTarget']>
  ): ReturnType<RuntimeWorkspaceCatalog['listKnownResolvedWorktreesForExplicitTarget']> {
    return this.workspaceQueries.listKnownResolvedWorktreesForExplicitTarget(...args)
  }

  protected listResolvedWorktrees(
    ...args: Parameters<RuntimeWorkspaceCatalog['listResolvedWorktrees']>
  ): ReturnType<RuntimeWorkspaceCatalog['listResolvedWorktrees']> {
    return this.workspaceQueries.listResolvedWorktrees(...args)
  }

  protected listResolvedWorktreeSnapshot(
    ...args: Parameters<RuntimeWorkspaceCatalog['listResolvedWorktreeSnapshot']>
  ): ReturnType<RuntimeWorkspaceCatalog['listResolvedWorktreeSnapshot']> {
    return this.workspaceQueries.listResolvedWorktreeSnapshot(...args)
  }

  protected resolveExplicitWorktreeIdScoped(
    ...args: Parameters<RuntimeWorkspaceCatalog['resolveExplicitWorktreeIdScoped']>
  ): ReturnType<RuntimeWorkspaceCatalog['resolveExplicitWorktreeIdScoped']> {
    return this.workspaceQueries.resolveExplicitWorktreeIdScoped(...args)
  }

  protected listRepoWorktreesForListing(
    ...args: Parameters<RuntimeWorkspaceRepoScans['listRepoWorktreesForListing']>
  ): ReturnType<RuntimeWorkspaceRepoScans['listRepoWorktreesForListing']> {
    return this.workspaceQueries.repoScans.listRepoWorktreesForListing(...args)
  }

  protected listRepoWorktreesForResolution(
    ...args: Parameters<RuntimeWorkspaceRepoScans['listRepoWorktreesForResolution']>
  ): ReturnType<RuntimeWorkspaceRepoScans['listRepoWorktreesForResolution']> {
    return this.workspaceQueries.repoScans.listRepoWorktreesForResolution(...args)
  }

  protected invalidateWorktreeScanCacheForRepo(
    ...args: Parameters<RuntimeWorkspaceRepoScans['invalidateWorktreeScanCacheForRepo']>
  ): ReturnType<RuntimeWorkspaceRepoScans['invalidateWorktreeScanCacheForRepo']> {
    return this.workspaceQueries.repoScans.invalidateWorktreeScanCacheForRepo(...args)
  }

  protected invalidateSshWorktreeScanCacheInternal(
    ...args: Parameters<RuntimeWorkspaceRepoScans['invalidateSshWorktreeScanCacheInternal']>
  ): ReturnType<RuntimeWorkspaceRepoScans['invalidateSshWorktreeScanCacheInternal']> {
    return this.workspaceQueries.repoScans.invalidateSshWorktreeScanCacheInternal(...args)
  }

  protected resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput,
    childRepo?: Repo
  ): Promise<WorktreeLineageResolution> {
    return this.worktreeLineage.resolveCreate(
      input,
      childRepo ? getRepoExecutionHostId(childRepo) : undefined
    )
  }

  protected getOrchestrationDbIfAvailable(): OrchestrationDb | null {
    return this._orchestrationDb
  }

  getNestedWorkerMaxDepth(): number {
    return resolveNestedWorkerMaxDepth({
      nestedWorkerMaxDepth: this.store?.getSettings?.()?.nestedWorkerMaxDepth
    })
  }

  hydrateInferredWorktreeLineage(): Promise<void> {
    return this.worktreeLineage.hydrate()
  }

  listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    return this.worktreeLineage.listWorktreeLineage()
  }

  listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>> {
    return this.worktreeLineage.listWorkspaceLineage()
  }

  protected requireStore(): RuntimeStore {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return this.store
  }
  protected async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return new Map((await this.listResolvedWorktrees()).map((worktree) => [worktree.id, worktree]))
  }

  protected invalidateResolvedWorktreeCache(): void {
    this.resolvedWorktrees.invalidateResolved()
  }

  invalidateWorktreeCatalog(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
  }

  notifyBranchRenamed(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
    this.notifyWorktreesChanged(repoId)
  }

  notifyWorktreeFolderRenamed(repoId: string, oldWorktreeId: string, newWorktreeId: string): void {
    this.clientSessionTabSelections.migrateWorktree(oldWorktreeId, newWorktreeId)
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
    this.notifier?.worktreesChanged(repoId, { oldWorktreeId, newWorktreeId })
    // Mirror notifyBranchRenamed so in-process onClientEvent listeners also see the rename.
    this.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  notifyFolderWorkspaceChanged(): void {
    this.invalidateResolvedWorktreeCache()
    this.notifyReposChanged()
  }
}
