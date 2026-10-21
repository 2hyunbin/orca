import { getLineageInputs } from '../sidebar/visible-worktree-indexes'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { compareWorktreeDisplayName } from '@/lib/worktree-display-name-order'
import { getWorktreeLineageProjection } from '../../../../shared/sidebar-list/worktree-lineage-projection'

export type AttachedWorktreeResolution = {
  folderWorkspace: FolderWorkspace | null
  childWorktrees: Worktree[]
  lineageChildrenByParentId: Map<string, Worktree[]>
  rootChildWorktrees: Worktree[]
}

type AttachedWorktreeResolverArgs = {
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
  folderWorkspaces: readonly FolderWorkspace[]
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreesByRepo: Record<string, readonly Worktree[]>
}

export function getWorktreeActivityTime(worktree: Worktree): number {
  return Math.max(worktree.lastActivityAt ?? 0, worktree.createdAt ?? 0, worktree.sortOrder ?? 0)
}

export function getAttachedWorktreesForFolderWorkspace({
  activeWorkspaceKey,
  activeWorktreeId,
  folderWorkspaces,
  workspaceLineageByChildKey,
  worktreeLineageById,
  worktreesByRepo
}: AttachedWorktreeResolverArgs): AttachedWorktreeResolution {
  const activeScope = parseWorkspaceKey(activeWorkspaceKey ?? activeWorktreeId ?? '')
  const folderWorkspace =
    activeScope?.type === 'folder'
      ? (folderWorkspaces.find((workspace) => workspace.id === activeScope.folderWorkspaceId) ??
        null)
      : null

  if (!folderWorkspace) {
    return {
      folderWorkspace: null,
      childWorktrees: [],
      lineageChildrenByParentId: new Map(),
      rootChildWorktrees: []
    }
  }

  const { worktreeMap, lineageById } = getLineageInputs({
    worktreesByRepo,
    folderWorkspaces,
    workspaceLineageByChildKey,
    worktreeLineageById
  })
  const folder = [...worktreeMap.values()].find(
    (row) => row.id === folderWorkspaceKey(folderWorkspace.id)
  )
  const { children } = getWorktreeLineageProjection(lineageById, worktreeMap)
  const childWorktrees = (folder ? (children.get(folder) ?? []) : [])
    .filter((row) => !row.isArchived)
    .toSorted(sortWorktreesByRecentActivity)
  const lineageChildrenByParentId = new Map(
    [...children]
      .filter(([parent]) => !parent.id.startsWith('folder:'))
      .map(([parent, rows]) => [
        getWorktreeHostIdentity(parent),
        rows.filter((row) => !row.isArchived).toSorted(sortWorktreesByRecentActivity)
      ])
  )
  return {
    folderWorkspace,
    childWorktrees,
    lineageChildrenByParentId,
    rootChildWorktrees: childWorktrees
  }
}

function sortWorktreesByRecentActivity(left: Worktree, right: Worktree): number {
  return (
    getWorktreeActivityTime(right) - getWorktreeActivityTime(left) ||
    compareWorktreeDisplayName(left, right)
  )
}
