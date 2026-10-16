import type React from 'react'
import type {
  Worktree,
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../../../shared/worktree/types'
import type { WorktreeDragGroup } from '../../worktree-manual-order'
import type { WorktreeDragUnitGroup } from '../../worktree-drag-units'
import type { WorktreeSidebarDropPreview } from '../../worktree-sidebar-drop-preview'
import type { WorktreeStatusDropRequest } from './use-session'
import type { WorktreeSidebarLineageDropTarget } from './row-state'

export const NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK = (): void => {}

export type WorktreeStatusDropAtIndexArgs = {
  worktreeIds: readonly string[]
  status: WorkspaceStatus
  dropIndex: number
  groups: readonly WorktreeDragGroup[]
}

// The shared surface every drop path (pointer, native drag, document capture) commits through.
export type WorktreeDropCommitContext = {
  scrollRef: React.RefObject<HTMLDivElement | null>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  worktreeDragGroups: readonly WorktreeDragGroup[]
  worktreeDragUnitGroups: readonly WorktreeDragUnitGroup[]
  computeWorktreeDrop: (pointerY: number) => WorktreeSidebarDropPreview | null
  computeWorktreeStatusDrop: (
    request: WorktreeStatusDropRequest
  ) => WorktreeSidebarDropPreview | null
  refreshWorktreeDragSession: () => boolean
  getEligibleLineageDropTarget: (
    target: WorktreeSidebarLineageDropTarget,
    draggedWorktrees: readonly Worktree[]
  ) => WorktreeSidebarLineageDropTarget
  commitWorktreeLineageParentDrop: (
    draggedWorktrees: readonly Worktree[],
    target: WorktreeSidebarLineageDropTarget
  ) => boolean
  clearReorderedWorktreeParents: (args: {
    draggedWorktrees: readonly Worktree[]
    sourceGroupKey: string
  }) => void
  clearWorktreeDrag: () => void
  onMoveWorktreesToStatus: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
  onMoveWorktreesToStatusAtIndex: (args: WorktreeStatusDropAtIndexArgs) => void
  onReorderWorktrees: (args: {
    groups: readonly WorktreeDragGroup[]
    sourceGroupKey: string
    draggedIds: readonly string[]
    dropIndex: number
  }) => void
  onPinWorktrees: (worktreeIds: readonly string[]) => void
}
