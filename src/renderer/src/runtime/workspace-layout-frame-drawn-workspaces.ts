// Which workspaces main's layout frames draw in the window, and when the window starts holding one.

import type { AppState } from '@/store/types'
import { pairedServerMirrors } from './paired-server-workspace'

type HeldWorkspacesStore = {
  getState: () => AppState
  subscribe: (listener: (state: AppState) => void) => () => void
}

/** Which workspaces frames draw: ones the window holds that no paired server mirrors. */
export function framesDrawWorkspace(state: AppState): (key: string) => boolean {
  const mirrored = pairedServerMirrors(state)
  return (key) =>
    (key in state.groupsByWorktree || key in state.unifiedTabsByWorktree) && !mirrored(key)
}

/**
 * Calls `onDrawn` when frames start drawing one of `unshown` (main's workspaces the window does not
 * show): the window's first visit to a workspace only main held, after which no frame need follow.
 */
export function onWorkspaceStartsDrawing(
  store: HeldWorkspacesStore,
  unshown: () => string[],
  onDrawn: () => void
): () => void {
  let held = store.getState()
  return store.subscribe((state) => {
    if (
      state.groupsByWorktree === held.groupsByWorktree &&
      state.unifiedTabsByWorktree === held.unifiedTabsByWorktree
    ) {
      return
    }
    held = state
    const drawn = framesDrawWorkspace(state)
    if (unshown().some(drawn)) {
      onDrawn()
    }
  })
}
