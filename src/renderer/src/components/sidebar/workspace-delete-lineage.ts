import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getProjectedWorktreeLineage } from '../../../../shared/sidebar-list/worktree-lineage-projection'
import { resolveWorktreeLineageParents } from '../../../../shared/resolved-worktree-lineage'

type WorkspaceDeleteLineage = {
  descendants: Worktree[]
  deleteAllTargets: Worktree[]
}

export function getWorkspaceDeleteLineage(
  parent: Worktree,
  worktrees: readonly Worktree[],
  lineageById: Record<string, WorktreeLineage>
): WorkspaceDeleteLineage {
  // Legacy child buckets carry no host; retain their existing same-id owner preference.
  const selected = new Map<string, Worktree>()
  for (const row of worktrees) {
    const prior = selected.get(row.id)
    if (!prior || prior.hostId !== parent.hostId) {
      selected.set(row.id, row)
    }
  }
  const parents = resolveWorktreeLineageParents([...selected.values()], (row) =>
    getProjectedWorktreeLineage(row, lineageById)
  )
  const childrenByParent = new Map<Worktree, Worktree[]>()
  for (const [child, owner] of parents) {
    const children = childrenByParent.get(owner) ?? []
    children.push(child)
    childrenByParent.set(owner, children)
  }

  const descendants: Worktree[] = []
  const childFirstTargets: Worktree[] = []
  const visiting = new Set<Worktree>()
  const emitted = new Set<Worktree>([parent])

  const visit = (row: Worktree): void => {
    if (visiting.has(row)) {
      return
    }
    visiting.add(row)
    const children = childrenByParent.get(row) ?? []
    for (const child of children) {
      if (emitted.has(child)) {
        continue
      }
      emitted.add(child)
      descendants.push(child)
      visit(child)
      if (!child.isMainWorktree) {
        childFirstTargets.push(child)
      }
    }
    visiting.delete(row)
  }

  visit(parent)

  return {
    descendants,
    // Why: if a child workspace physically lives inside the parent directory,
    // deleting descendants first prevents Git's force-delete path from removing
    // the child as untracked content under the parent.
    deleteAllTargets: [...childFirstTargets, parent]
  }
}
