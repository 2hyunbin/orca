import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import { getWorkspaceLineageRows } from '../../../../shared/sidebar-list/worktree-lineage-projection'
import { mergeWorkspaceLineageRecords } from '../../../../shared/resolved-worktree-lineage'
export { getWorkspaceLineageRows as getLineageAncestorIndex } from '../../../../shared/sidebar-list/worktree-lineage-projection'

/**
 * Rank of each key in the frozen sidebar sort order. Keyed on the array the sort
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

type LineageState = {
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>
} & Partial<
  Pick<AppState, 'folderWorkspaces' | 'worktreeLineageById' | 'workspaceLineageByChildKey'>
>
const noEdges = {}
type LineageInputs = {
  worktreeMap: Map<string, Worktree>
  lineageById: AppState['worktreeLineageById']
}
const inputCache = new WeakMap<object, WeakMap<object, WeakMap<object, LineageInputs>>>()
export function getLineageInputs(state: LineageState) {
  const worktreeMap = getWorkspaceLineageRows(state.worktreesByRepo, state.folderWorkspaces)
  const worktreeEdges = state.worktreeLineageById ?? noEdges
  const workspaceEdges = state.workspaceLineageByChildKey ?? noEdges
  // Renderer subscribers need stable snapshots of their immutable source maps.
  let byWorkspaceEdges = inputCache.get(worktreeEdges)
  if (!byWorkspaceEdges) {
    byWorkspaceEdges = new WeakMap()
    inputCache.set(worktreeEdges, byWorkspaceEdges)
  }
  let byRows = byWorkspaceEdges.get(workspaceEdges)
  if (!byRows) {
    byRows = new WeakMap()
    byWorkspaceEdges.set(workspaceEdges, byRows)
  }
  let inputs = byRows.get(worktreeMap)
  if (!inputs) {
    inputs = {
      worktreeMap,
      lineageById: mergeWorkspaceLineageRecords(worktreeEdges, workspaceEdges)
    }
    byRows.set(worktreeMap, inputs)
  }
  return inputs
}
