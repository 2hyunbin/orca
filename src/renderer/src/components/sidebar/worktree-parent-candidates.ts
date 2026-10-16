import { requiresParentWorktreeReference } from '../../../../shared/resolved-worktree-lineage'
import { WORKTREE_CROSS_MACHINE_PARENT_RUNTIME_CAPABILITY } from '../../../../shared/runtime-capability-constants'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
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
  runtimeStatuses?: ReadonlyMap<string, RuntimeEnvironmentStatus>
  cyclicLineageIds?: ReadonlySet<string>
}

export function canLinkWorktreeHosts(
  childHost: string,
  parentHost: string,
  statuses?: ReadonlyMap<string, RuntimeEnvironmentStatus>
): boolean {
  return (
    !requiresParentWorktreeReference(childHost, parentHost) ||
    !childHost.startsWith('runtime:') ||
    statuses
      ?.get(childHost.slice('runtime:'.length))
      ?.status?.capabilities?.includes(WORKTREE_CROSS_MACHINE_PARENT_RUNTIME_CAPABILITY) === true
  )
}

function getWorktreeOwnerHostId(
  worktree: Worktree,
  repoMap: Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>>
): string | null {
  const repo = repoMap.get(worktree.repoId)
  return repo ? getWorktreeExecutionHostId(worktree, repo) : (worktree.hostId ?? null)
}

export function getEligibleWorktreeParents({
  child,
  worktrees,
  lineageById,
  worktreeMap,
  repoMap,
  runtimeStatuses,
  cyclicLineageIds: precomputedCyclicLineageIds
}: ParentCandidateArgs): Worktree[] {
  const childHostId = getWorktreeOwnerHostId(child, repoMap)
  const cyclicLineageIds =
    precomputedCyclicLineageIds ?? getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  return worktrees.filter((candidate) =>
    isEligibleWorktreeParent({
      child,
      candidateParent: candidate,
      lineageById,
      worktreeMap,
      repoMap,
      runtimeStatuses,
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
  cyclicLineageIds,
  runtimeStatuses,
  childHostId = getWorktreeOwnerHostId(child, repoMap)
}: Omit<ParentCandidateArgs, 'worktrees'> & {
  candidateParent: Worktree
  childHostId?: string | null
}): boolean {
  return (
    childHostId !== null &&
    canLinkWorktreeHosts(
      childHostId,
      getWorktreeOwnerHostId(candidateParent, repoMap) ?? '',
      runtimeStatuses
    ) &&
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
