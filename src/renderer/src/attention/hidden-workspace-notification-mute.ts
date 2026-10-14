import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees, getIndexedRepoMap } from '@/store/worktree-repo-index'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { Worktree } from '../../../shared/worktree/types'
import {
  anySidebarSwitchIsOn,
  isFolderWorkspaceHiddenBySidebarSwitch,
  isHiddenBySidebarSwitch
} from '@/components/sidebar/sidebar-switch-hidden-workspace'
import { buildVisibleWorktreeOptionsFromState } from '@/components/sidebar/visible-worktree-options-from-state'
import { getLineageAncestorIndex } from '@/components/sidebar/visible-worktree-indexes'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo
} from '@/components/sidebar/worktree-lineage-projection'

/**
 * Whether attention from this workspace must raise nothing — no unread, banner, sound or push —
 * because a Filters-menu switch hides it and "Notify About Hidden Workspaces" is off.
 *
 * Fails open: unhydrated settings or UI state, terminals not yet reconnected (every restored
 * workspace would read as sleeping), or a workspace this store has no record of, notify.
 * Ids are not host-qualified, so a same-id twin on another host that the switches show notifies.
 */
export function isWorkspaceNotificationMutedBySidebarFilters(
  state: AppState,
  workspaceId: string
): boolean {
  if (
    state.settings?.notifications?.notifyHiddenWorkspaces !== false ||
    !state.persistedUIReady ||
    !state.workspaceSessionReady ||
    !anySidebarSwitchIsOn(state)
  ) {
    return false
  }
  const repoMap = getIndexedRepoMap(state.repos)
  const inputs = buildVisibleWorktreeOptionsFromState(state, repoMap)
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const folder = state.folderWorkspaces.find((item) => item.id === scope.folderWorkspaceId)
    return folder !== undefined && isFolderWorkspaceHiddenBySidebarSwitch(folder, inputs)
  }
  const all = getIndexedAllWorktrees(state.worktreesByRepo)
  const matches = all.filter((worktree) => worktree.id === workspaceId && !worktree.isArchived)
  if (matches.length === 0) {
    return false
  }
  const isHidden = (worktree: Worktree): boolean =>
    isHiddenBySidebarSwitch(worktree, repoMap.get(worktree.repoId), inputs)
  if (!matches.every(isHidden)) {
    return false
  }
  return !isShownAsLineageParent(state, workspaceId, all, isHidden)
}

/** The sidebar renders a hidden parent above any child it shows, so that parent still notifies. */
function isShownAsLineageParent(
  state: AppState,
  workspaceId: string,
  all: readonly Worktree[],
  isHidden: (worktree: Worktree) => boolean
): boolean {
  const lineageById = state.worktreeLineageById
  const index = getLineageAncestorIndex(state.worktreesByRepo)
  const cyclic = getCyclicProjectedWorktreeLineageIds(lineageById, index)
  for (const worktree of all) {
    if (worktree.isArchived || worktree.id === workspaceId || isHidden(worktree)) {
      continue
    }
    const seen = new Set<string>()
    let current = worktree
    while (!seen.has(current.id)) {
      seen.add(current.id)
      const lineage = getLineageRenderInfo(current, lineageById, index, cyclic)
      if (lineage.state !== 'valid') {
        break
      }
      if (lineage.parent.id === workspaceId) {
        return true
      }
      current = lineage.parent
    }
  }
  return false
}
