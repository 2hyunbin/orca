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
const inputCache = new WeakMap<
  object,
  WeakMap<
    object,
    {
      worktreeMap: Map<string, Worktree>
      lineageById: AppState['worktreeLineageById']
    }
  >
>()
export function getLineageInputs(state: LineageState) {
  const worktreeMap = getWorkspaceLineageRows(state.worktreesByRepo, state.folderWorkspaces)
  const lineageById = mergeWorkspaceLineageRecords(
    state.worktreeLineageById ?? noEdges,
    state.workspaceLineageByChildKey ?? noEdges
  )
  let byRows = inputCache.get(lineageById)
  if (!byRows) {
    byRows = new WeakMap()
    inputCache.set(lineageById, byRows)
  }
  let inputs = byRows.get(worktreeMap)
  if (!inputs) {
    inputs = { worktreeMap, lineageById }
    byRows.set(worktreeMap, inputs)
  }
  return inputs
}
