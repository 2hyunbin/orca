import { enrichMissingRepoGitRemoteIdentities } from '../../repo-git-remote-identity-enrichment'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import { RESOLVED_WORKTREE_CACHE_TTL_MS } from '../orca-runtime-postlude'
import { getWorktreeScanMutationRevision } from '../../local-worktree-scan-generation'
import { resolveLocalProjectRuntimesForRepos } from '../../project-runtime-git-options'
import { getAgentLaunchPlatformForRepo } from '../runtime-agent-launch-resolution'
import {
  resolveRepoWorktreeRows,
  resolveScopedWorktreeIdRow
} from '../repo-worktree-row-resolution'
import { projectResolvedWorktreeLineage } from '../../../shared/resolved-worktree-lineage'
import type { RepoWorktreeRowDeps } from '../repo-worktree-row-resolution'
import { listRuntimeFolderWorkspaces } from '../runtime-worktree-filesystem'
import type { Repo } from '../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { RuntimeResolvedWorktreeCache } from '../runtime-resolved-worktree-cache'
import { RuntimeWorkspaceSelectors } from './workspace-selectors'
import { RuntimeWorkspaceRepoScans } from './workspace-repo-scans'
import type { RuntimeWorkspaceRepoScanHost } from './workspace-repo-scan-refresh'

export type RuntimeWorkspaceCatalogHost = RuntimeWorkspaceRepoScanHost & {
  invalidateResolvedWorktreeCache(): void
  notifyReposChanged(): void
  getValidatedExplicitWorktreeIdSelector(selector: string): string | null
  listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult>
}

export class RuntimeWorkspaceCatalog {
  readonly resolvedWorktrees = new RuntimeResolvedWorktreeCache()
  readonly repoScans: RuntimeWorkspaceRepoScans
  readonly selectors: RuntimeWorkspaceSelectors
  constructor(private readonly host: RuntimeWorkspaceCatalogHost) {
    this.repoScans = new RuntimeWorkspaceRepoScans(
      host,
      () => this.resolvedWorktrees.invalidateResolved(),
      (repo, projectRuntimeByRepoId) =>
        host.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
    )
    this.selectors = new RuntimeWorkspaceSelectors({
      getStore: () => this.store,
      getValidatedExplicitWorktreeIdSelector: (selector) =>
        host.getValidatedExplicitWorktreeIdSelector(selector),
      hasFreshResolvedWorktreeCache: () => this.hasFreshResolvedWorktreeCache(),
      resolveExplicitWorktreeIdScoped: (worktreeId, hostId) =>
        this.resolveExplicitWorktreeIdScoped(worktreeId, hostId),
      listResolvedWorktrees: () => this.listResolvedWorktrees()
    })
  }
  private get store() {
    return this.host.getStore()
  }
  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }

  enrichMissingRepoGitRemoteIdentities(): void {
    if (!this.store) {
      return
    }
    enrichMissingRepoGitRemoteIdentities(this.store, {
      onChanged: () => {
        this.host.invalidateResolvedWorktreeCache()
        this.host.notifyReposChanged()
      }
    })
  }

  private requireStore() {
    return this.host.requireStore()
  }
  private buildResolvedWorktreeFromId(worktreeId: string) {
    return this.selectors.buildResolvedWorktreeFromId(worktreeId)
  }
  private listRepoWorktreesForListing(
    ...args: Parameters<RuntimeWorkspaceRepoScans['listRepoWorktreesForListing']>
  ) {
    return this.repoScans.listRepoWorktreesForListing(...args)
  }
  listKnownResolvedWorktreesForExplicitTarget(
    targetWorktreeId: string,
    targetWorktree: ResolvedWorktree | null
  ): ResolvedWorktree[] {
    if (!this.store || !targetWorktree) {
      return []
    }
    const target = splitWorktreeIdForFilesystem(targetWorktreeId)
    if (!target?.repoId || !target.worktreePath) {
      // Folder workspace keys have no repo/path tuple, but the converted row
      // is already authoritative for this explicit target.
      return [targetWorktree]
    }
    const worktreeIds = new Set(
      Object.keys(this.store.getAllWorktreeMeta()).filter((worktreeId) => {
        const parsed = splitWorktreeIdForFilesystem(worktreeId)
        return (
          parsed?.repoId === target.repoId &&
          Boolean(parsed.worktreePath) &&
          (isPathInsideOrEqual(target.worktreePath, parsed.worktreePath) ||
            isPathInsideOrEqual(parsed.worktreePath, target.worktreePath))
        )
      })
    )
    worktreeIds.add(targetWorktreeId)

    const resolved: ResolvedWorktree[] = []
    for (const worktreeId of worktreeIds) {
      const worktree =
        worktreeId === targetWorktreeId
          ? targetWorktree
          : this.buildResolvedWorktreeFromId(worktreeId)
      if (worktree) {
        resolved.push(worktree)
      }
    }
    return resolved
  }

  hasFreshResolvedWorktreeCache(): boolean {
    return this.resolvedWorktrees.isFresh(getWorktreeScanMutationRevision())
  }

  async listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    return (await this.listResolvedWorktreeSnapshot()).worktrees
  }

  async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
    if (!this.store) {
      return { worktrees: [], platformByRepoId: new Map() }
    }
    return this.resolvedWorktrees.getSnapshot(
      () => this.computeResolvedWorktrees(),
      RESOLVED_WORKTREE_CACHE_TTL_MS,
      getWorktreeScanMutationRevision()
    )
  }

  private async computeResolvedWorktrees(): Promise<ResolvedWorktreeSnapshot> {
    if (!this.store) {
      return { worktrees: [], platformByRepoId: new Map() }
    }
    const metaById = this.store.getAllWorktreeMeta() ?? {}
    const repos = this.store.getRepos()
    const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(this.requireStore(), repos)
    const platformByRepoId = new Map(
      repos.map((repo) => [
        repo.id,
        getAgentLaunchPlatformForRepo(repo, projectRuntimeByRepoId.get(repo.id))
      ])
    )
    const deps = this.repoWorktreeRowDeps()
    const perRepoWorktrees = await Promise.all(
      repos.map(
        async (repo) => await resolveRepoWorktreeRows(deps, repo, metaById, projectRuntimeByRepoId)
      )
    )
    const lineageById = this.store?.getAllWorktreeLineage?.() ?? {}
    const worktrees = perRepoWorktrees.flatMap((rows) =>
      projectResolvedWorktreeLineage(rows, lineageById)
    )
    return { worktrees, platformByRepoId }
  }

  private repoWorktreeRowDeps(): RepoWorktreeRowDeps {
    const store = this.requireStore()
    return {
      store,
      scanRepo: (repo, projectRuntimeByRepoId) =>
        this.listRepoWorktreesForListing(repo, projectRuntimeByRepoId),
      listFolderWorkspaces: (repo, repoOwnerCount) =>
        listRuntimeFolderWorkspaces(store, repo, repoOwnerCount)
    }
  }

  async resolveExplicitWorktreeIdScoped(
    worktreeId: string,
    requiredHostId?: ExecutionHostId
  ): Promise<ResolvedWorktree | null> {
    if (!this.store) {
      return null
    }
    return await resolveScopedWorktreeIdRow(this.repoWorktreeRowDeps(), worktreeId, requiredHostId)
  }
}
