import type { WorktreeMetaBatchUpdate, WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  getActiveSidebarWorkspaceId,
  parseWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import { getWorktreeLineageAncestors } from '../../../../components/sidebar/worktree-lineage-projection'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getIndexedAllWorktrees } from '../../../worktree-repo-index'

function hasChangedLineageAncestor(
  get: WorktreeSliceGet,
  worktreeId: string,
  changedWorktreeIds: ReadonlySet<string>
): boolean {
  const state = get()
  const child = state.getKnownWorktreeById(worktreeId)
  if (!child) {
    return false
  }
  const rows = new Map(
    getIndexedAllWorktrees(state.worktreesByRepo).map((row) => [getWorktreeHostIdentity(row), row])
  )
  return getWorktreeLineageAncestors(child, state.worktreeLineageById, rows).some((parent) =>
    changedWorktreeIds.has(getWorktreeHostIdentity(parent))
  )
}

export function createSetWorktreesPinnedAndReveal(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['setWorktreesPinnedAndReveal'] {
  return (worktreeIds, isPinned) => {
    // Only follow a toggled row with the viewport when it's the focused worktree, not an unfocused card.
    const activeSidebarWorktreeId = getActiveSidebarWorkspaceId(
      get().activeWorkspaceKey,
      get().activeWorktreeId
    )
    // Skip worktrees already in the target state so a no-op toggle doesn't scroll the viewport away.
    const updates: WorktreeMetaBatchUpdate[] = []
    const changedWorktreeIds = new Set<string>()
    let didChange = false
    let revealWorktreeId: string | null = null
    for (const worktreeId of worktreeIds) {
      const current = get().getKnownWorktreeById(worktreeId)
      if (!current || current.isPinned === isPinned) {
        continue
      }
      didChange = true
      changedWorktreeIds.add(getWorktreeHostIdentity(current))
      const workspaceScope = parseWorkspaceKey(worktreeId)
      if (workspaceScope?.type === 'folder') {
        void get().updateWorktreeMeta(
          worktreeId,
          { isPinned },
          { executionHostId: current.hostId ?? 'local' }
        )
      } else {
        updates.push({
          worktreeId,
          updates: { isPinned },
          executionHostId: current.hostId ?? 'local'
        })
      }
      if (revealWorktreeId === null && worktreeId === activeSidebarWorktreeId) {
        revealWorktreeId = worktreeId
      }
    }
    if (!didChange) {
      return
    }
    if (
      revealWorktreeId === null &&
      activeSidebarWorktreeId !== null &&
      get().settings?.showPinnedWorktreesInGroups !== true &&
      hasChangedLineageAncestor(get, activeSidebarWorktreeId, changedWorktreeIds)
    ) {
      revealWorktreeId = activeSidebarWorktreeId
    }
    // updateWorktreesMeta applies the store update synchronously, so the reveal below sees the row already rendered.
    if (updates.length > 0) {
      void get().updateWorktreesMeta(updates)
    }
    if (revealWorktreeId !== null) {
      get().revealWorktreeInSidebar(revealWorktreeId, { behavior: 'smooth', highlight: true })
    }
  }
}
