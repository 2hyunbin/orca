import { resolveLocalProjectRuntimeForRepo } from '../../project-runtime-git-options'
import type { Repo } from '../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'
import { getSshGitProviderGeneration } from '../../providers/ssh-git-dispatch'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host'
import { withUnregisteredRemovalCheckouts } from '../../worktree-removal-listing'
import type { RuntimeWorktreeScanCache, RuntimeWorktreeScanInFlight } from '../orca-runtime-core'
import { resolveWorktreeScanCacheTtlMs } from '../runtime-worktree-scan-cache'
import {
  RuntimeWorkspaceRepoScanRefresh,
  type RuntimeWorkspaceRepoScanHost
} from './workspace-repo-scan-refresh'

export class RuntimeWorkspaceRepoScans {
  private readonly worktreeScanGenerations = new Map<string, number>()
  private readonly worktreeScanCache = new Map<string, RuntimeWorktreeScanCache>()
  private readonly worktreeScanInFlight = new Map<string, RuntimeWorktreeScanInFlight>()
  private readonly refresh: RuntimeWorkspaceRepoScanRefresh
  constructor(
    private readonly host: RuntimeWorkspaceRepoScanHost,
    private readonly invalidateResolved: () => void,
    private readonly scanForListing: (
      repo: Repo,
      projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
    ) => Promise<RuntimeWorktreeScanResult>
  ) {
    this.refresh = new RuntimeWorkspaceRepoScanRefresh(host)
  }
  get pendingFingerprintProbes(): ReadonlySet<string> {
    return this.refresh.pendingFingerprintProbes
  }

  private get store() {
    return this.host.getStore()
  }
  private requireStore() {
    return this.host.requireStore()
  }
  private refreshRepoWorktreeScan(
    ...args: Parameters<RuntimeWorkspaceRepoScanRefresh['refreshRepoWorktreeScan']>
  ) {
    return this.refresh.refreshRepoWorktreeScan(...args)
  }
  async listRepoWorktreesForListing(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    const scan = await this.scanForListing(repo, projectRuntimeByRepoId)
    return scan.ok && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      ? { ok: true, worktrees: await withUnregisteredRemovalCheckouts(repo.id, scan.worktrees) }
      : scan
  }

  async listRepoWorktreesForResolution(
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
        ? `ssh:${sshConnectionId}:${getSshGitProviderGeneration(sshConnectionId)}`
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
  invalidateWorktreeScanCacheForRepo(repoId: string): void {
    const prefix = `${repoId}\0`
    const scopeKeys = new Set(
      this.store
        ?.getRepos()
        .filter((repo) => repo.id === repoId)
        .map((repo) => `${repoId}\0${getRepoExecutionHostId(repo)}`) ?? []
    )
    for (const keys of [
      this.worktreeScanGenerations.keys(),
      this.worktreeScanCache.keys(),
      this.worktreeScanInFlight.keys()
    ]) {
      for (const key of keys) {
        if (key.startsWith(prefix)) {
          scopeKeys.add(key)
        }
      }
    }
    for (const key of scopeKeys) {
      this.worktreeScanGenerations.set(key, (this.worktreeScanGenerations.get(key) ?? 0) + 1)
      this.worktreeScanCache.delete(key)
      this.worktreeScanInFlight.delete(key)
    }
  }

  invalidateSshWorktreeScanCacheInternal(targetId: string): void {
    const repos = this.store?.getRepos() ?? []
    const affectedRepos = repos.filter((repo) => getRepoSshConnectionId(repo) === targetId)
    const affectedScopeKeys = new Set(
      affectedRepos.map((repo) => `${repo.id}\0${getRepoExecutionHostId(repo)}`)
    )
    for (const key of affectedScopeKeys) {
      this.worktreeScanGenerations.set(key, (this.worktreeScanGenerations.get(key) ?? 0) + 1)
      this.worktreeScanCache.delete(key)
      this.worktreeScanInFlight.delete(key)
    }
    if (affectedScopeKeys.size > 0) {
      this.invalidateResolved()
    }
  }
}
