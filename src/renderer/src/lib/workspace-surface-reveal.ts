import type { AppState } from '@/store/types'
import {
  revealFloatingWorkspacePanelFor,
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

export type WorkspaceSurfaceSelectState = FloatingWorkspacePanelRevealState & {
  setActiveWorktree: (worktreeId: string) => unknown
}

export type WorkspaceSurfaceRevealOptions = {
  /** Tabs the caller just created into a requested group; activation would otherwise prune its empty groups. */
  createdTabIds?: readonly string[]
}

/** Shows a workspace where it lives: the floating one in its panel (selecting it blanks the main window), others as the main selection and a visit. */
export function revealWorkspaceSurface(
  state: WorkspaceSurfaceRevealState,
  worktreeId: string,
  opts?: WorkspaceSurfaceRevealOptions
): void {
  if (revealFloatingWorkspacePanelFor(state, worktreeId)) {
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

/** Makes a workspace's surface current for a tab opening beside the user: no view switch, visit, history or sidebar scroll. */
export function selectWorkspaceSurface(
  state: WorkspaceSurfaceSelectState,
  worktreeId: string
): void {
  if (!revealFloatingWorkspacePanelFor(state, worktreeId)) {
    state.setActiveWorktree(worktreeId)
  }
}
