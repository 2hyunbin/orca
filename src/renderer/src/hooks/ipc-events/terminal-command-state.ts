import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { focusRuntimeTerminalSurface } from '@/runtime/mounted-terminal-tab-registry'
import type { AppState } from '../../store/types'

export function focusTerminalInitiatedTab(
  tabId: string,
  leafId?: string | null,
  worktreeId?: string
): void {
  if (!focusRuntimeTerminalSurface(tabId, leafId, worktreeId)) {
    focusTerminalTabSurface(tabId, leafId)
  }
}

export function activateTerminalInitiatedWorktree(store: AppState, worktreeId: string): void {
  store.setActiveView('terminal')
  store.setActiveWorktree(worktreeId)
  store.markWorktreeVisited(worktreeId)
  if (!store.isNavigatingHistory) {
    store.recordWorktreeVisit(worktreeId)
  }
}
