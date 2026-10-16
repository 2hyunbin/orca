import { getIndexedWorktreeByIdentity } from '@/store/worktree-repo-index'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { isEligibleWorktreeParent } from '../../worktree-parent-candidates'
import { getCyclicProjectedWorktreeLineageIds } from '../../worktree-lineage-projection'
import { getReorderedWorktreeIdsToUnnest } from '../../worktree-lineage-drag-drop'
import { unnestWorktrees } from '../../worktree-unnest'
import type { WorktreeDragGroup } from '../../worktree-manual-order'
import type { WorktreeSidebarLineageDropTarget } from './row-state'

export type WorktreeLineageDropCommit = ReturnType<typeof useWorktreeLineageDropCommit>

// Nesting and un-nesting are the two lineage mutations a sidebar drag can commit.
export function useWorktreeLineageDropCommit(args: {
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreeDragGroups: readonly WorktreeDragGroup[]
  worktrees: readonly Worktree[]
}) {
  const { repoMap, worktreeLineageById, worktreeDragGroups } = args
  const assignWorktreeParent = useAppStore((s) => s.assignWorktreeParent)
  const updateWorktreeLineage = useAppStore((s) => s.updateWorktreeLineage)
  const lineageWorktreeMap = useMemo(
    () => new Map(args.worktrees.map((row) => [getWorktreeHostIdentity(row), row])),
    [args.worktrees]
  )
  const cyclicLineageIds = useMemo(
    () => getCyclicProjectedWorktreeLineageIds(worktreeLineageById, lineageWorktreeMap),
    [worktreeLineageById, lineageWorktreeMap]
  )

  const hoveredParent = useRef<{
    children: readonly Worktree[]
    hostKey: string
    identity: Worktree['identity']
  } | null>(null)
  const getEligibleLineageDropTarget = useCallback(
    (
      target: WorktreeSidebarLineageDropTarget,
      draggedWorktrees: readonly Worktree[]
    ): WorktreeSidebarLineageDropTarget => {
      const parentId = target.lineageParentId
      if (!parentId) {
        hoveredParent.current = null
        return target
      }
      if (
        hoveredParent.current?.children !== draggedWorktrees ||
        hoveredParent.current.hostKey !== parentId
      ) {
        hoveredParent.current = {
          children: draggedWorktrees,
          hostKey: parentId,
          identity: target.lineageParentIdentity ?? lineageWorktreeMap.get(parentId)?.identity
        }
      }
      const identity = hoveredParent.current.identity
      const candidateParent =
        identity &&
        getIndexedWorktreeByIdentity(useAppStore.getState().worktreesByRepo, identity.key)
      const children = draggedWorktrees.map(
        (captured) =>
          captured.identity &&
          getIndexedWorktreeByIdentity(
            useAppStore.getState().worktreesByRepo,
            captured.identity.key
          )
      )
      if (!candidateParent?.identity || children.some((child) => !child)) {
        return { ...target, lineageParentIdentity: undefined }
      }
      const canAssignAll =
        children.length > 0 &&
        children.every(
          (child) =>
            child &&
            isEligibleWorktreeParent({
              child,
              candidateParent,
              lineageById: worktreeLineageById,
              worktreeMap: lineageWorktreeMap,
              repoMap,
              cyclicLineageIds
            })
        )
      return canAssignAll
        ? { ...target, lineageParentIdentity: candidateParent.identity }
        : { ...target, lineageParentId: null }
    },
    [cyclicLineageIds, repoMap, worktreeLineageById, lineageWorktreeMap]
  )

  const commitWorktreeLineageParentDrop = useCallback(
    (draggedWorktrees: readonly Worktree[], target: WorktreeSidebarLineageDropTarget): boolean => {
      const checked = getEligibleLineageDropTarget(target, draggedWorktrees)
      const parent = checked.lineageParentIdentity
      void (async () => {
        if (!checked.lineageParentId || !parent) {
          throw new Error('selector_not_found')
        }
        await Promise.all(
          draggedWorktrees.map((row) =>
            assignWorktreeParent(row.id, {
              identity: row.identity,
              parentWorktreeId: `identity:${parent.key}`
            })
          )
        )
      })().catch((err) => {
        console.error('Failed to nest workspace:', err)
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.failedNestWorkspace',
            'Failed to nest workspace'
          )
        )
      })
      return Boolean(checked.lineageParentId && parent)
    },
    [assignWorktreeParent, getEligibleLineageDropTarget]
  )

  const clearReorderedWorktreeParents = useCallback(
    (unnestArgs: { draggedWorktrees: readonly Worktree[]; sourceGroupKey: string }) => {
      const sourceGroup = worktreeDragGroups.find(
        (group) => group.key === unnestArgs.sourceGroupKey
      )
      if (!sourceGroup) {
        return
      }
      const ids = getReorderedWorktreeIdsToUnnest({
        draggedIds: unnestArgs.draggedWorktrees.map(getWorktreeHostIdentity),
        sourceGroupIds: unnestArgs.draggedWorktrees
          .filter((row) => sourceGroup.worktreeIds.includes(row.id))
          .map(getWorktreeHostIdentity),
        lineageById: worktreeLineageById,
        worktreeMap: lineageWorktreeMap,
        cyclicLineageIds
      })
      if (ids.length === 0) {
        return
      }
      // Why: dropping a nested card on a reorder line is the un-nest escape hatch; clear only the dragged children.
      void unnestWorktrees(
        unnestArgs.draggedWorktrees.filter((row) => ids.includes(getWorktreeHostIdentity(row))),
        updateWorktreeLineage
      )
    },
    [
      cyclicLineageIds,
      updateWorktreeLineage,
      worktreeDragGroups,
      worktreeLineageById,
      lineageWorktreeMap
    ]
  )

  return {
    getEligibleLineageDropTarget,
    commitWorktreeLineageParentDrop,
    clearReorderedWorktreeParents
  }
}
