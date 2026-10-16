import { selectResolvedWorktreeLineage } from '../../../src/shared/resolved-worktree-lineage'
import {
  buildWorktreeOccurrencePlan,
  getExpandedWorktreeOccurrences,
  type WorktreeOccurrencePlan
} from '../../../src/shared/worktree-occurrence-plan'
import type { Worktree } from './workspace-list-types'
import { getWorktreeRowIdentity } from './worktree-host-row-identity'

type WorktreeLineageIdentitySource = Pick<Worktree, 'worktreeId' | 'hostId'>

export function getMobileWorkspaceLineageGroupKey(worktree: WorktreeLineageIdentitySource): string {
  return `workspace-lineage:${encodeURIComponent(getWorktreeRowIdentity(worktree))}`
}

/** Children over the host's selected edges; older hosts have already resolved their locator hints. */
export function getMobileWorkspaceLineageChildren(
  worktrees: readonly Worktree[]
): Map<string, Worktree[]> {
  const rows = worktrees.map((row) => ({
    ...row,
    id: row.worktreeId,
    instanceId: row.worktreeInstanceId ?? getWorktreeRowIdentity(row)
  }))
  const { selected } = selectResolvedWorktreeLineage(rows, (child) => {
    if (!child.parentWorktreeId) {
      return null
    }
    return {
      worktreeId: child.id,
      worktreeInstanceId: child.lineageWorktreeInstanceId ?? child.instanceId,
      parentWorktreeId: child.parentWorktreeId,
      parentWorktreeInstanceId:
        child.parentWorktreeInstanceId ??
        getWorktreeRowIdentity({ worktreeId: child.parentWorktreeId, hostId: child.hostId }),
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 0
    }
  })
  const children = new Map<string, Worktree[]>()
  for (const row of rows) {
    const parent = selected.get(getWorktreeRowIdentity(row))?.parent
    if (parent) {
      const key = getWorktreeRowIdentity(parent)
      children.set(key, [...(children.get(key) ?? []), row])
    }
  }
  return children
}

export function getMobileOccurrenceRows(
  plan: WorktreeOccurrencePlan<Worktree>,
  sectionKey: string,
  collapsedGroups: ReadonlySet<string>
): Worktree[] {
  return getExpandedWorktreeOccurrences(plan.bySection.get(sectionKey) ?? [], (worktree) =>
    collapsedGroups.has(getMobileWorkspaceLineageGroupKey(worktree))
  ).map((occurrence) => ({
    ...occurrence.row,
    sectionListKey: occurrence.key,
    lineageDepth: occurrence.depth,
    lineageChildCount: occurrence.childCount,
    lineageCollapsed:
      occurrence.childCount > 0 &&
      collapsedGroups.has(getMobileWorkspaceLineageGroupKey(occurrence.row)),
    isLastLineageChild: occurrence.isLastChild,
    showProjectName: occurrence.showProjectName
  }))
}

export function applyMobileWorkspaceLineage(
  worktrees: readonly Worktree[],
  collapsedGroups: ReadonlySet<string> = new Set()
): Worktree[] {
  const plan = buildWorktreeOccurrencePlan({
    rows: worktrees,
    childrenByParentIdentity: getMobileWorkspaceLineageChildren(worktrees),
    identityOf: getWorktreeRowIdentity,
    isPinned: () => false,
    duplicatePinned: false,
    sectionsOf: () => [{ key: 'all', items: worktrees }],
    projectIdOf: (worktree) => worktree.repoId
  })
  return getMobileOccurrenceRows(plan, 'all', collapsedGroups)
}
