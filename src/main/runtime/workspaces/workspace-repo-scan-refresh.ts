import type { Repo } from '../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanCache, RuntimeWorktreeScanRefresh } from '../orca-runtime-core'
import { resolveWorktreeScanCacheTtlMs } from '../runtime-worktree-scan-cache'
import {
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
} from '../orca-runtime-postlude'
import { getLocalProjectWorktreeGitOptionsForRuntime } from '../../project-runtime-git-options'
import { withTimeoutResult } from '../runtime-async-boundaries'
import { readRepoWorktreeAdminFingerprint } from '../repo-worktree-admin-fingerprint'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'
import { scanLocalRepoWorktreesForResolution } from '../repo-worktree-resolution-scan'
import { dropRepeatedWorktreeRows } from '../repeated-worktree-rows'
import { getSshGitProvider } from '../../providers/ssh-git-dispatch'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { listStoredWorktreeRowsForRepo } from '../repo-worktree-row-resolution'
import { getRepoSshConnectionId } from '../../../shared/execution-host'
import type { RuntimeStore } from '../runtime-store-contract'

const lastFingerprintUnknownWarnAt = new Map<string, number>()

// Why once per reconcile window: a wedged mount answers "unknown" on every poll.
function warnFingerprintUnknownOnce(repoId: string, reason: string): void {
  const now = Date.now()
  const last = lastFingerprintUnknownWarnAt.get(repoId)
  if (last !== undefined && now - last < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS) {
    return
  }
  lastFingerprintUnknownWarnAt.set(repoId, now)
  console.warn(
    '[worktree-scan] admin fingerprint unknown; reusing cached rows until the reconcile ceiling',
    {
      repoId,
      reason
    }
  )
}

export type RuntimeWorkspaceRepoScanHost = {
  getStore(): RuntimeStore | null
  requireStore(): RuntimeStore
}

export class RuntimeWorkspaceRepoScanRefresh {
  readonly pendingFingerprintProbes = new Set<string>()
  constructor(private readonly host: RuntimeWorkspaceRepoScanHost) {}
  private get store(): RuntimeStore | null {
    return this.host.getStore()
  }
  private requireStore(): RuntimeStore {
    return this.host.requireStore()
  }
  async refreshRepoWorktreeScan(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined,
    cached: RuntimeWorktreeScanCache | null
  ): Promise<RuntimeWorktreeScanRefresh> {
    const scannedAt = Date.now()
    // SSH and WSL-routed repos run Git off-host, so a local admin-dir read cannot describe them.
    // Resolve the execution host rather than reading `connectionId`: a row stamped only
    // `executionHostId: 'ssh:*'` is just as off-host, and fingerprinting it stats client paths.
    const fingerprintCapable =
      !getRepoSshConnectionId(repo) &&
      // Why: a repo whose scan TTL already reaches the reconciliation interval can never reuse a
      // fingerprint, so reading one would be pure work. Agent-scratch roots are that case today.
      resolveWorktreeScanCacheTtlMs(repo) < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS &&
      !getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime).wslDistro
    // Why issue it before the scan: a change landing while the scan runs must not be stamped as
    // already-observed, or the next probe would mask it until the reconciliation deadline.
    const probe = fingerprintCapable ? this.startRepoWorktreeAdminFingerprintProbe(repo) : null
    const reusable =
      cached?.result.ok === true &&
      scannedAt - cached.scannedAt < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
        ? cached
        : null
    // Why reuse on "cannot tell": a probe that is still pending or timed out says nothing about
    // the repo, and turning that into a full scan is the feedback loop of #19312 (slow mount →
    // timeouts → scans → more load). The original `scannedAt` is kept, so the reconcile ceiling
    // still forces a real scan on schedule.
    const reuseCached = (): RuntimeWorktreeScanRefresh | null =>
      reusable
        ? {
            result: reusable.result,
            adminFingerprint: reusable.adminFingerprint,
            adminFingerprintProbe: null,
            scannedAt: reusable.scannedAt
          }
        : null
    if (probe === 'in-flight') {
      const reused = reuseCached()
      if (reused) {
        warnFingerprintUnknownOnce(repo.id, 'previous probe still pending')
        return reused
      }
    } else if (probe && reusable) {
      // Why await only here: this is the one branch whose decision needs the probe. A scan-bound
      // caller must never wait on it, or every cold read pays filesystem latency it cannot use.
      const probed = await withTimeoutResult(probe, WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS)
      if (!probed.ok) {
        warnFingerprintUnknownOnce(repo.id, 'probe expired')
        return (
          reuseCached() ??
          (await this.scanRepoWorktreesForRefresh(repo, projectRuntime, null, scannedAt))
        )
      }
      // A known fingerprint that matches proves nothing changed; null means the repo cannot be
      // fingerprinted, which (like a mismatch) needs a real scan.
      if (probed.value !== null && probed.value === reusable.adminFingerprint) {
        return {
          result: reusable.result,
          adminFingerprint: probed.value,
          adminFingerprintProbe: null,
          scannedAt: reusable.scannedAt
        }
      }
    }
    return await this.scanRepoWorktreesForRefresh(
      repo,
      projectRuntime,
      probe === 'in-flight' ? null : probe,
      scannedAt
    )
  }

  private async scanRepoWorktreesForRefresh(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined,
    probe: Promise<string | null> | null,
    scannedAt: number
  ): Promise<RuntimeWorktreeScanRefresh> {
    const result = dropRepeatedWorktreeRows(
      await this.listRepoWorktreesForResolutionUncached(repo, projectRuntime)
    )
    return { result, adminFingerprint: null, adminFingerprintProbe: probe, scannedAt }
  }

  private startRepoWorktreeAdminFingerprintProbe(repo: Repo): Promise<string | null> | 'in-flight' {
    if (this.pendingFingerprintProbes.has(repo.id)) {
      return 'in-flight'
    }
    this.pendingFingerprintProbes.add(repo.id)
    return readRepoWorktreeAdminFingerprint(repo.path)
      .catch(() => null)
      .finally(() => {
        this.pendingFingerprintProbes.delete(repo.id)
      })
  }

  private async listRepoWorktreesForResolutionUncached(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined
  ): Promise<RuntimeWorktreeScanResult> {
    // Why not `repo.connectionId`: SSH ownership has two spellings, and a repo carrying only
    // `executionHostId: 'ssh:*'` would otherwise be scanned on the client against a remote path —
    // `git worktree list` then reports nothing, so the remote worktrees never resolve at all.
    const sshConnectionId = getRepoSshConnectionId(repo)
    if (!sshConnectionId) {
      return await scanLocalRepoWorktreesForResolution(
        repo.path,
        getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime)
      )
    }
    const provider = getSshGitProvider(sshConnectionId)
    if (!provider) {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
    try {
      return { ok: true, worktrees: await provider.listWorktrees(repo.path) }
    } catch {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
  }

  private listStoredWorktreesForResolution(repo: Repo): GitWorktreeInfo[] {
    return this.store ? listStoredWorktreeRowsForRepo(this.requireStore(), repo) : []
  }
}
