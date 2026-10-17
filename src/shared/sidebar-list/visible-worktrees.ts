import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import {
  filterWorkspaceRows,
  type WorkspaceRowFactReader,
  type WorkspaceRowFilters
} from '../workspace-view/workspace-row-filters'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo
} from './worktree-lineage-projection'

export type VisibleSidebarWorktreeInputs = {
  /** Every catalog row, one per host-qualified identity. */
  rows: readonly Worktree[]
  /** Non-archived rows by id, the lineage ancestors a visible child may pull in. */
  ancestorById: Map<string, Worktree>
  /** Rank of each id in the frozen sort order; unranked rows go last. */
  rankById: ReadonlyMap<string, number>
  filters: WorkspaceRowFilters
  facts: WorkspaceRowFactReader<Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  filterRepoIds: readonly string[]
  injectLineageAncestors?: boolean
  preserveLineageParentOrder?: boolean
  forcedVisibleWorktreeIds?: readonly string[]
}

/** The sidebar's visible worktrees, in display order, before grouping. */
export function selectVisibleSidebarWorktrees(inputs: VisibleSidebarWorktreeInputs): Worktree[] {
  // Why: sidebar lineage is structural. Archived workspaces stay hidden, but
  // every other valid ancestor can bypass filters so children never orphan.
  const lineageAncestorById = inputs.ancestorById
  const selectedRepoIds = inputs.filterRepoIds.length > 0 ? new Set(inputs.filterRepoIds) : null

  let all = filterWorkspaceRows(inputs.rows, inputs.filters, inputs.facts)

  if (inputs.forcedVisibleWorktreeIds && inputs.forcedVisibleWorktreeIds.length > 0) {
    const includedIds = new Set(all.map((worktree) => worktree.id))
    for (const worktreeId of inputs.forcedVisibleWorktreeIds) {
      const worktree = lineageAncestorById.get(worktreeId)
      if (worktree && !includedIds.has(worktreeId)) {
        includedIds.add(worktreeId)
        all.push(worktree)
      }
    }
  }

  // Apply cached sort order. Items not yet in the cache (e.g. brand-new
  // worktrees before the next sortEpoch bump) are appended at the end.
  // Manual placement belongs to the parent, even when a hidden child has a higher rank.
  if (inputs.injectLineageAncestors !== false && inputs.preserveLineageParentOrder) {
    all = addVisibleLineageAncestors(
      all,
      lineageAncestorById,
      inputs.worktreeLineageById,
      selectedRepoIds
    )
  }
  const orderIndex = inputs.rankById
  all.sort((a, b) => {
    const ai = orderIndex.get(a.id) ?? Infinity
    const bi = orderIndex.get(b.id) ?? Infinity
    return ai - bi
  })

  return inputs.injectLineageAncestors === false || inputs.preserveLineageParentOrder
    ? all
    : addVisibleLineageAncestors(
        all,
        lineageAncestorById,
        inputs.worktreeLineageById,
        selectedRepoIds
      )
}
function addVisibleLineageAncestors(
  worktrees: Worktree[],
  worktreeById: Map<string, Worktree>,
  lineageById: Record<string, WorktreeLineage>,
  selectedRepoIds: ReadonlySet<string> | null
): Worktree[] {
  const result: Worktree[] = []
  const included = new Set<string>()
  const visiting = new Set<string>()
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeById)

  const addWithAncestors = (worktree: Worktree): void => {
    const identity = getWorktreeHostIdentity(worktree)
    if (included.has(identity) || visiting.has(identity)) {
      return
    }
    visiting.add(identity)
    const lineage = getLineageRenderInfo(worktree, lineageById, worktreeById, cyclicLineageIds)
    if (
      lineage.state === 'valid' &&
      (!selectedRepoIds || selectedRepoIds.has(lineage.parent.repoId))
    ) {
      // Why: a repository filter is an explicit boundary; other filters keep
      // valid ancestors so visible children retain their hierarchy.
      addWithAncestors(lineage.parent)
    }
    visiting.delete(identity)
    if (!included.has(identity)) {
      included.add(identity)
      result.push(worktree)
    }
  }

  for (const worktree of worktrees) {
    addWithAncestors(worktree)
  }
  return result
}
