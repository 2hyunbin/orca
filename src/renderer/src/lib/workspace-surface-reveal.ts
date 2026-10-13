import type { AppState } from '@/store/types'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import {
  revealFloatingWorkspacePanel,
  type FloatingWorkspacePanelRevealState
} from './floating-workspace-panel-reveal'

export type WorkspaceSurfaceRevealState = FloatingWorkspacePanelRevealState &
  Pick<
    AppState,
    | 'setActiveView'
    | 'setActiveWorktree'
    | 'markWorktreeVisited'
    | 'recordWorktreeVisit'
    | 'isNavigatingHistory'
    | 'revealWorktreeInSidebar'
  >

export type WorkspaceSurfaceRevealOptions = {
  /** Tabs the caller just created into a requested group; activation would otherwise prune its empty groups. */
  createdTabIds?: readonly string[]
}

/** Opens the floating panel when it owns the workspace; false means the main window owns it. */
export function revealFloatingOwnedWorkspace(
  state: FloatingWorkspacePanelRevealState,
  worktreeId: string
): boolean {
  if (!isFloatingWorkspaceId(worktreeId)) {
    return false
  }
  revealFloatingWorkspacePanel(state)
  return true
}

/**
 * Shows the user a workspace where it lives. The floating workspace has its own panel and is never
 * the main window's selection — selecting it there blanks the main window — so it only opens the
 * panel; any other workspace becomes the main window's selection and a visit.
 */
export function revealWorkspaceSurface(
  state: WorkspaceSurfaceRevealState,
  worktreeId: string,
  opts?: WorkspaceSurfaceRevealOptions
): void {
  if (revealFloatingOwnedWorkspace(state, worktreeId)) {
    return
  }
  state.setActiveView('terminal')
  if (opts?.createdTabIds) {
    state.setActiveWorktree(worktreeId, undefined, { createdTabIds: opts.createdTabIds })
  } else {
    state.setActiveWorktree(worktreeId)
  }
  state.markWorktreeVisited(worktreeId)
  if (!state.isNavigatingHistory) {
    state.recordWorktreeVisit(worktreeId)
  }
  state.revealWorktreeInSidebar(worktreeId)
}

/**
 * Makes a workspace's surface current for a tab opening beside the user, who is not navigating:
 * no view switch, visit, history entry or sidebar scroll.
 */
export function selectWorkspaceSurfaceOwner(
  state: FloatingWorkspacePanelRevealState & { setActiveWorktree: (worktreeId: string) => unknown },
  worktreeId: string
): void {
  if (!revealFloatingOwnedWorkspace(state, worktreeId)) {
    state.setActiveWorktree(worktreeId)
  }
}
