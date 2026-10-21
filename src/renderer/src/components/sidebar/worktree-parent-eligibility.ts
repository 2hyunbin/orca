import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeLineageProjection } from '../../../../shared/sidebar-list/worktree-lineage-projection'
import { getSavedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

type ParentEligibilityArgs = {
  child: Worktree
  candidateParent: Worktree
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
}

export function canAssignWorktreeParent({
  child,
  candidateParent,
  lineageById,
  worktreeMap
}: ParentEligibilityArgs): boolean {
  const identity = getWorktreeHostIdentity(child)
  const graph = getWorktreeLineageProjection(lineageById, worktreeMap)
  const parent = worktreeMap.get(getWorktreeHostIdentity(candidateParent)) ?? candidateParent
  if (
    identity === getWorktreeHostIdentity(parent) ||
    graph.parents.get(worktreeMap.get(identity) ?? child) === parent
  ) {
    return false
  }
  let current: Worktree | undefined = parent
  while (current) {
    const key = getWorktreeHostIdentity(current)
    if (
      key === identity ||
      graph.cyclicIdentities.has(key) ||
      getSavedWorktreeLineage(current, lineageById)?.parentStore === 'external'
    ) {
      return false
    }
    current = graph.parents.get(current)
  }
  return true
}
