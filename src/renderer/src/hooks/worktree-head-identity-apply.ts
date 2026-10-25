import type { Worktree, WorktreeHeadIdentity } from '../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'

export type WorktreeHeadIdentityApplyDeps = {
  getWorktreesForRepo: (repoId: string) => Worktree[] | undefined
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string | null },
    ownerHostId: ExecutionHostId | null
  ) => void
}

function findWorktreeByPath(worktrees: Worktree[], worktreePath: string): Worktree | undefined {
  const exact = worktrees.find((worktree) => worktree.path === worktreePath)
  if (exact) {
    return exact
  }
  // Both paths are Git-derived, but separator/casing normalization can differ
  // between `git worktree list` output and gitdir-file contents on Windows.
  const normalized = normalizeRuntimePathForComparison(worktreePath)
  return worktrees.find(
    (worktree) => normalizeRuntimePathForComparison(worktree.path) === normalized
  )
}

/** Applies head/branch snapshots from the status-only watcher path to store
 *  rows. Unknown paths are skipped: row creation/removal is structural and
 *  stays owned by the full worktree listing. */
export function applyWorktreeHeadIdentities(
  data: { repoId: string; identities: WorktreeHeadIdentity[] },
  deps: WorktreeHeadIdentityApplyDeps
): void {
  const worktrees = deps.getWorktreesForRepo(data.repoId)
  if (!worktrees || worktrees.length === 0) {
    return
  }
  for (const identity of data.identities) {
    const worktree = findWorktreeByPath(worktrees, identity.worktreePath)
    if (!worktree) {
      continue
    }
    // Why: this watcher reads this machine's checkouts, never a same-path twin on another host.
    deps.updateWorktreeGitIdentity(
      worktree.id,
      { head: identity.head, branch: identity.branch },
      LOCAL_EXECUTION_HOST_ID
    )
  }
}
