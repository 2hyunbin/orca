// Layout-owner builds: a CLI or orchestration send, wait or read on a handle whose pane main holds
// with no terminal yet (a saved pane not started since restore) starts it through main's one
// starter first, then the caller delivers as to any live terminal.

import type { RestoredPane } from '../recovery/restored-pane-start'
import { startedMainTerminalSurfaces } from './main-terminal-surfaces'

type Starter = { ensureRestoredPaneStarted(pane: RestoredPane): Promise<string | null> }

/**
 * Starts the handle's pane when main owns it and it has no terminal. Resolves once that terminal
 * is registered; rejects with the start's error (the pane then shows why), or `terminal_not_found`
 * when main no longer holds the pane. A pane with a terminal, or one main does not own, is left as is.
 */
export async function startRestoredHandlePane(
  starter: Starter,
  leaf: { worktreeId: string; tabId: string; leafId: string; ptyId: string | null }
): Promise<void> {
  if (leaf.ptyId || !startedMainTerminalSurfaces(starter)?.ownsWorkspace(leaf.worktreeId)) {
    return
  }
  const started = await starter.ensureRestoredPaneStarted({
    worktreeId: leaf.worktreeId,
    tabId: leaf.tabId,
    leafId: leaf.leafId
  })
  if (started === null) {
    throw new Error('terminal_not_found')
  }
}
