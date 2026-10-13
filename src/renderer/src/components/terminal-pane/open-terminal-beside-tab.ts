import { useAppStore } from '@/store'
import { createFloatingWorkspaceTerminalTab } from '@/lib/floating-workspace-tab-creation'
import { revealFloatingOwnedWorkspace } from '@/lib/workspace-surface-reveal'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'

/** Opens a new terminal where this tab lives; a new terminal's shell has Orca's agent functions. */
export function openTerminalBesideTab(terminalTabId: string): boolean {
  const state = useAppStore.getState()
  const tab = Object.values(state.unifiedTabsByWorktree)
    .flat()
    .find(
      (candidate) => candidate.contentType === 'terminal' && candidate.entityId === terminalTabId
    )
  if (!tab) {
    return false
  }
  if (revealFloatingOwnedWorkspace(state, tab.worktreeId)) {
    void createFloatingWorkspaceTerminalTab(state)
    return true
  }
  // Why always: Activity can show this pane behind its own view even when its workspace is active.
  if (activateAndRevealWorkspace(tab.worktreeId) === false) {
    return false
  }
  void useAppStore.getState().openNewTerminalTabInActiveWorkspace(tab.groupId)
  return true
}
