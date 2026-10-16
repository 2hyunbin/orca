import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'

type WorktreesByRepo = Record<string, Worktree[]>

/** Cached host-qualified rows keep lineage scans stable across unrelated store writes. */
const lineageAncestorIndexCache = new WeakMap<WorktreesByRepo, Map<string, Worktree>>()
const filteredAncestorIndexCache = new WeakMap<
  WorktreesByRepo,
  WeakMap<ReadonlyMap<string, Repo>, Map<string, Map<string, Worktree>>>
>()

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

export function getFilteredLineageAncestorIndex(
  worktreesByRepo: WorktreesByRepo,
  scope: {
    visibleHostIds?: readonly ExecutionHostId[] | null
    repoIds: readonly string[]
    repoMap: ReadonlyMap<string, Repo>
    defaultHostId: ExecutionHostId
    hostIdForRow: (row: Worktree) => ExecutionHostId | null
  }
): Map<string, Worktree> {
  const { visibleHostIds, repoIds, hostIdForRow } = scope
  const index = getLineageAncestorIndex(worktreesByRepo)
  if (!visibleHostIds && repoIds.length === 0) {
    return index
  }
  let byRepoMap = filteredAncestorIndexCache.get(worktreesByRepo)
  if (!byRepoMap) {
    byRepoMap = new WeakMap()
    filteredAncestorIndexCache.set(worktreesByRepo, byRepoMap)
  }
  let byFilter = byRepoMap.get(scope.repoMap)
  if (!byFilter) {
    byFilter = new Map()
    byRepoMap.set(scope.repoMap, byFilter)
  }
  const key = JSON.stringify([visibleHostIds, repoIds, scope.defaultHostId])
  let filtered = byFilter.get(key)
  if (!filtered) {
    filtered = new Map(
      [...index].filter(
        ([, row]) =>
          (!visibleHostIds || visibleHostIds.includes(hostIdForRow(row)!)) &&
          (repoIds.length === 0 || repoIds.includes(row.repoId))
      )
    )
    byFilter.set(key, filtered)
  }
  return filtered
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
