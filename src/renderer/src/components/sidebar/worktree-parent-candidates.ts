import { selectedWorktreeTransport } from '@/lib/selected-worktree-reference'
import { getRuntimeTargetHostId } from '@/runtime/runtime-client-target'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { canAssignWorktreeParent } from './worktree-parent-eligibility'
import { getCyclicProjectedWorktreeLineageIds } from './worktree-lineage-projection'

type ParentCandidateArgs = {
  child: Worktree
  worktrees: readonly Worktree[]
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>>
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  cyclicLineageIds?: ReadonlySet<string>
}

function getWorktreeOwnerHostId(
  worktree: Worktree,
  repoMap: Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>>,
  repos?: ParentCandidateArgs['repos']
): string | null {
  const repo = repoMap.get(worktree.repoId)
  const target = selectedWorktreeTransport(
    { repos: repos ?? (repo ? [{ id: worktree.repoId, ...repo }] : []) },
    worktree
  )
  return target ? getRuntimeTargetHostId(target) : null
}

export function getEligibleWorktreeParents({
  child,
  worktrees,
  lineageById,
  worktreeMap,
  repoMap,
  repos,
  cyclicLineageIds: precomputedCyclicLineageIds
}: ParentCandidateArgs): Worktree[] {
  const childHostId = getWorktreeOwnerHostId(child, repoMap, repos)
  const cyclicLineageIds =
    precomputedCyclicLineageIds ?? getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  return worktrees.filter((candidate) =>
    isEligibleWorktreeParent({
      child,
      candidateParent: candidate,
      lineageById,
      worktreeMap,
      repoMap,
      repos,
      cyclicLineageIds,
      childHostId
    })
  )
}

export function isEligibleWorktreeParent({
  child,
  candidateParent,
  lineageById,
  worktreeMap,
  repoMap,
  repos,
  cyclicLineageIds,
  childHostId = getWorktreeOwnerHostId(child, repoMap, repos)
}: Omit<ParentCandidateArgs, 'worktrees'> & {
  candidateParent: Worktree
  childHostId?: string | null
}): boolean {
  return (
    childHostId !== null &&
    getWorktreeOwnerHostId(candidateParent, repoMap, repos) === childHostId &&
    !candidateParent.isArchived &&
    canAssignWorktreeParent({
      child,
      candidateParent,
      lineageById,
      worktreeMap,
      cyclicLineageIds
    })
  )
}
