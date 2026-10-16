import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo
} from './worktree-lineage-projection'

type ParentEligibilityArgs = {
  child: Worktree
  candidateParent: Worktree
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  cyclicLineageIds?: ReadonlySet<string>
}

export function canAssignWorktreeParent({
  child,
  candidateParent,
  lineageById,
  worktreeMap,
  cyclicLineageIds: precomputedCyclicLineageIds
}: ParentEligibilityArgs): boolean {
  if (getWorktreeHostIdentity(child) === getWorktreeHostIdentity(candidateParent)) {
    return false
  }

  const cyclicLineageIds =
    precomputedCyclicLineageIds ?? getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  const childLineage = getLineageRenderInfo(child, lineageById, worktreeMap, cyclicLineageIds)
  if (
    childLineage.state === 'valid' &&
    getWorktreeHostIdentity(childLineage.parent) === getWorktreeHostIdentity(candidateParent)
  ) {
    return false
  }

  let current: Worktree | undefined = candidateParent
  const visited = new Set<string>()
  while (current) {
    if (
      visited.has(getWorktreeHostIdentity(current)) ||
      cyclicLineageIds.has(getWorktreeHostIdentity(current))
    ) {
      return false
    }
    visited.add(getWorktreeHostIdentity(current))
    if (getWorktreeHostIdentity(current) === getWorktreeHostIdentity(child)) {
      return false
    }
    const lineageInfo = getLineageRenderInfo(current, lineageById, worktreeMap, cyclicLineageIds)
    // Why: stale instance links are broken edges for renderer filtering; the
    // backend remains the authoritative final cycle guard.
    current = lineageInfo.state === 'valid' ? lineageInfo.parent : undefined
  }

  return true
}
