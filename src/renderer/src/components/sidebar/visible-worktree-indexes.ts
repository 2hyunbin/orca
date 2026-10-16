import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import type { Worktree } from '../../../../shared/worktree/types'

type WorktreesByRepo = Record<string, Worktree[]>

/** Cached host-qualified rows keep lineage scans stable across unrelated store writes. */
const lineageAncestorIndexCache = new WeakMap<WorktreesByRepo, Map<string, Worktree>>()

export function getLineageAncestorIndex(worktreesByRepo: WorktreesByRepo): Map<string, Worktree> {
  const cached = lineageAncestorIndexCache.get(worktreesByRepo)
  if (cached) {
    return cached
  }
  const index = new Map<string, Worktree>()
  for (const worktree of getIndexedAllWorktrees(worktreesByRepo)) {
    if (!worktree.isArchived) {
      index.set(getWorktreeHostIdentity(worktree), worktree)
    }
  }
  lineageAncestorIndexCache.set(worktreesByRepo, index)
  return index
}

/**
 * Rank of each id in the frozen sidebar sort order. Keyed on the array the sort
 * hook already holds identity-stable across unrelated store writes.
 */
const sortedWorktreeRankIndexCache = new WeakMap<readonly string[], Map<string, number>>()

export function getSortedWorktreeRankIndex(sortedIds: readonly string[]): Map<string, number> {
  const cached = sortedWorktreeRankIndexCache.get(sortedIds)
  if (cached) {
    return cached
  }
  const index = new Map(sortedIds.map((id, rank) => [id, rank]))
  sortedWorktreeRankIndexCache.set(sortedIds, index)
  return index
}
