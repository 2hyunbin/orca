import { OrcaRuntimeWithReadKittyFile } from '../orca-runtime-read-kitty-file'
import type { RuntimeWorkspaceRepoScanRefresh } from './workspace-repo-scan-refresh'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import { RESOLVED_WORKTREE_CACHE_TTL_MS } from '../orca-runtime-postlude'
import { getWorktreeScanMutationRevision } from '../../local-worktree-scan-generation'
import {
  resolveLocalProjectRuntimeForRepo,
  resolveLocalProjectRuntimesForRepos
} from '../../project-runtime-git-options'
import { getAgentLaunchPlatformForRepo } from '../runtime-agent-launch-resolution'
import {
  joinRepoWorktreeRows,
  resolveRepoWorktreeRows,
  resolveScopedWorktreeIdRow,
  scanRepoWorktreeRows,
  type RepoWorktreeRowDeps,
  type RepoWorktreeRowsScan
} from '../repo-worktree-row-resolution'
import { isFolderRepo } from '../../../shared/repo-kind'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../shared/worktree/host-qualified-identity'
import { projectResolvedWorktreeLineage } from '../../../shared/resolved-worktree-lineage'
import { listRuntimeFolderWorkspaces } from '../runtime-worktree-filesystem'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host'
import { withUnregisteredRemovalCheckouts } from '../../worktree-removal-listing'
import { withoutInFlightWorktreeCreates } from '../../worktree-create-in-flight'
import { preserveFolderUpgradeWorktreePath } from '../../folder-upgrade-worktree-path'
import type { RuntimeWorktreeScanCache } from '../orca-runtime-core'
import { resolveWorktreeScanCacheTtlMs } from '../runtime-worktree-scan-cache'

/** Per-repo scans by repo and execution host, since one repo id can live on two hosts. */
export type ResolvedWorktreeRepoScans = Map<string, RepoWorktreeRowsScan>

export type ResolvedWorktreeScanJoin = ResolvedWorktreeSnapshot & {
  /** Git repos the scans predate, which list no rows until scanned. */
  unscannedRepoCount: number
  /** Rows a scan that reached a verdict listed; a stalled scan's stored rows carry no branch. */
  authoritativeIds: ReadonlySet<HostScopedWorktreeKey>
}

function resolvedWorktreeRepoScanKey(repo: Repo): string {
  return `${getRepoExecutionHostId(repo)}\0${repo.id}`
}

export abstract class RuntimeWorkspaceCatalog extends OrcaRuntimeWithReadKittyFile {
  protected abstract refreshRepoWorktreeScan(
    ...args: Parameters<RuntimeWorkspaceRepoScanRefresh['refreshRepoWorktreeScan']>
  ): ReturnType<RuntimeWorkspaceRepoScanRefresh['refreshRepoWorktreeScan']>

  protected listKnownResolvedWorktreesForExplicitTarget(
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

  /** A warm fleet snapshot already answers any selector for free, so scoped scanning must yield to it. */
  protected hasFreshResolvedWorktreeCache(): boolean {
    return this.resolvedWorktrees.isFresh(getWorktreeScanMutationRevision())
  }

  protected async listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    return (await this.listResolvedWorktreeSnapshot()).worktrees
  }

  protected async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
    if (!this.store) {
      return { worktrees: [], platformByRepoId: new Map() }
    }
    return this.resolvedWorktrees.getSnapshot(
      () => this.computeResolvedWorktrees(),
      RESOLVED_WORKTREE_CACHE_TTL_MS,
      getWorktreeScanMutationRevision()
    )
  }

  protected async computeResolvedWorktrees(): Promise<ResolvedWorktreeSnapshot> {
    if (!this.store) {
      return { worktrees: [], platformByRepoId: new Map() }
    }
    const metaById = this.store.getAllWorktreeMeta() ?? {}
    const repos = this.store.getRepos()
    const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(this.requireStore(), repos)
    const platformByRepoId = this.platformsByRepoId(repos, projectRuntimeByRepoId)
    const deps = this.repoWorktreeRowDeps()
    const perRepoWorktrees = await Promise.all(
      repos.map(
        async (repo) => await resolveRepoWorktreeRows(deps, repo, metaById, projectRuntimeByRepoId)
      )
    )
    const lineageById = this.store?.getAllWorktreeLineage?.() ?? {}
    const worktrees = projectResolvedWorktreeLineage(perRepoWorktrees.flat(), lineageById)
    return { worktrees, platformByRepoId }
  }

  private platformsByRepoId(
    repos: readonly Repo[],
    projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Map<string, NodeJS.Platform> {
    return new Map(
      repos.map((repo) => [
        repo.id,
        getAgentLaunchPlatformForRepo(repo, projectRuntimeByRepoId.get(repo.id))
      ])
    )
  }

  /** Every git repo's scan, with no metadata: `joinResolvedWorktreeScans` adds that at read. */
  protected async scanResolvedWorktreeRepos(): Promise<ResolvedWorktreeRepoScans> {
    const scans: ResolvedWorktreeRepoScans = new Map()
    if (!this.store) {
      return scans
    }
    const repos = this.store.getRepos().filter((repo) => !isFolderRepo(repo))
    const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(this.requireStore(), repos)
    const deps = this.repoWorktreeRowDeps()
    await Promise.all(
      repos.map(async (repo) => {
        scans.set(
          resolvedWorktreeRepoScanKey(repo),
          await scanRepoWorktreeRows(deps, repo, projectRuntimeByRepoId)
        )
      })
    )
    return scans
  }

  /**
   * The fleet listing from cached scans and the store as it is now, synchronously. A git repo the
   * scans predate lists no rows yet and is counted, so its owner can scan again.
   */
  protected joinResolvedWorktreeScans(scans: ResolvedWorktreeRepoScans): ResolvedWorktreeScanJoin {
    if (!this.store) {
      return {
        worktrees: [],
        platformByRepoId: new Map(),
        unscannedRepoCount: 0,
        authoritativeIds: new Set()
      }
    }
    const metaById = this.store.getAllWorktreeMeta() ?? {}
    const repos = this.store.getRepos()
    const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(this.requireStore(), repos)
    const platformByRepoId = this.platformsByRepoId(repos, projectRuntimeByRepoId)
    const deps = this.repoWorktreeRowDeps()
    let unscannedRepoCount = 0
    const authoritativeIds = new Set<HostScopedWorktreeKey>()
    const perRepoWorktrees = repos.map((repo) => {
      const scan = scans.get(resolvedWorktreeRepoScanKey(repo)) ?? null
      if (!scan && !isFolderRepo(repo)) {
        unscannedRepoCount += 1
      }
      const rows = joinRepoWorktreeRows(deps, repo, scan, metaById)
      if (scan?.ok) {
        for (const row of rows) {
          authoritativeIds.add(composeWorktreeHostIdentity(row.hostId, row.id))
        }
      }
      return rows
    })
    const lineageById = this.store.getAllWorktreeLineage?.() ?? {}
    const worktrees = projectResolvedWorktreeLineage(perRepoWorktrees.flat(), lineageById)
    return { worktrees, platformByRepoId, unscannedRepoCount, authoritativeIds }
  }

  /** Bind the runtime-owned scan cache and folder-workspace stamping into the row resolver. */
  protected repoWorktreeRowDeps(): RepoWorktreeRowDeps {
    const store = this.requireStore()
    return {
      store,
      scanRepo: (repo, projectRuntimeByRepoId) =>
        this.listRepoWorktreesForListing(repo, projectRuntimeByRepoId),
      listFolderWorkspaces: (repo, repoOwnerCount) =>
        listRuntimeFolderWorkspaces(store, repo, repoOwnerCount)
    }
  }

  protected async resolveExplicitWorktreeIdScoped(
    worktreeId: string,
    requiredHostId?: ExecutionHostId
  ): Promise<ResolvedWorktree | null> {
    if (!this.store) {
      return null
    }
    return await resolveScopedWorktreeIdRow(this.repoWorktreeRowDeps(), worktreeId, requiredHostId)
  }

  /** The resolution scan plus the checkouts this host's removals own that Git no longer lists. */
  protected async listRepoWorktreesForListing(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    const cached = await this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
    // Why here: paired clients list through this scan (`worktree.detectedList`), so a folder-upgraded
    // checkout must carry the folder's locator here or its id loses metadata and terminals (#30150).
    const scan = { ...cached, worktrees: preserveFolderUpgradeWorktreePath(repo, cached.worktrees) }
    return scan.ok && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      ? {
          ok: true,
          worktrees: await withUnregisteredRemovalCheckouts(
            repo.id,
            withoutInFlightWorktreeCreates(repo.id, scan.worktrees)
          )
        }
      : scan
  }

  protected async listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    // Resolve the execution host, not the raw field: an `executionHostId: 'ssh:*'` row with no
    // `connectionId` would otherwise get a local project runtime and a `local:default` cache key,
    // so its scan neither routes remotely nor re-runs when the SSH provider is replaced.
    const sshConnectionId = getRepoSshConnectionId(repo)
    const projectRuntime = projectRuntimeByRepoId
      ? projectRuntimeByRepoId.get(repo.id)
      : !sshConnectionId
        ? resolveLocalProjectRuntimeForRepo(this.requireStore(), repo)
        : undefined
    const runtimeKey = projectRuntime
      ? projectRuntime.status === 'resolved'
        ? projectRuntime.runtime.cacheKey
        : projectRuntime.repair.cacheKey
      : sshConnectionId
        ? `ssh:${sshConnectionId}`
        : 'local:default'
    const now = Date.now()
    const scanScopeKey = `${repo.id}\0${getRepoExecutionHostId(repo)}`
    const generation = this.worktreeScanGenerations.get(scanScopeKey) ?? 0
    const cached = this.worktreeScanCache.get(scanScopeKey)
    if (
      cached?.generation === generation &&
      cached.runtimeKey === runtimeKey &&
      cached.expiresAt > now
    ) {
      return cached.result
    }
    const inFlight = this.worktreeScanInFlight.get(scanScopeKey)
    if (inFlight?.generation === generation && inFlight.runtimeKey === runtimeKey) {
      const refresh = await inFlight.promise
      if (generation !== (this.worktreeScanGenerations.get(scanScopeKey) ?? 0)) {
        return this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
      }
      return refresh.result
    }
    const reusableCached =
      cached?.generation === generation && cached.runtimeKey === runtimeKey ? cached : null
    const promise = this.refreshRepoWorktreeScan(repo, projectRuntime, reusableCached)
    this.worktreeScanInFlight.set(scanScopeKey, { generation, runtimeKey, promise })
    try {
      const refresh = await promise
      if (generation !== (this.worktreeScanGenerations.get(scanScopeKey) ?? 0)) {
        return this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
      }
      if (
        (refresh.result.ok || !sshConnectionId) &&
        this.worktreeScanInFlight.get(scanScopeKey)?.promise === promise
      ) {
        const entry: RuntimeWorktreeScanCache = {
          generation,
          runtimeKey,
          result: refresh.result,
          expiresAt: Date.now() + resolveWorktreeScanCacheTtlMs(repo),
          adminFingerprint: refresh.adminFingerprint,
          scannedAt: refresh.scannedAt
        }
        this.worktreeScanCache.set(scanScopeKey, entry)
        void refresh.adminFingerprintProbe?.then((fingerprint) => {
          if (this.worktreeScanCache.get(scanScopeKey) === entry) {
            entry.adminFingerprint = fingerprint
          }
        })
      }
      return refresh.result
    } finally {
      if (this.worktreeScanInFlight.get(scanScopeKey)?.promise === promise) {
        this.worktreeScanInFlight.delete(scanScopeKey)
      }
    }
  }
}
