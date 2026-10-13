import type { RuntimePtyController } from './runtime-pty-controller-contract'

type PaneCreate = Parameters<NonNullable<RuntimePtyController['claimStablePaneCreate']>>[0]

/**
 * Terminal tabs the runtime is starting: written to the layout, process not yet bound. A list
 * built from the layout leaves them out until the start ends, as a tab is published once bound.
 */
export class StartingTerminalTabs {
  private readonly byWorktree = new Map<string, Set<string>>()

  constructor(private readonly onEnded: (worktreeId: string) => void) {}

  /** Claims the pane's create with the controller and marks its tab; the release ends both. */
  claim(controller: RuntimePtyController | null | undefined, pane: PaneCreate): () => void {
    const releaseCreate = controller?.claimStablePaneCreate?.(pane)
    const tabs = this.byWorktree.get(pane.worktreeId) ?? new Set<string>()
    this.byWorktree.set(pane.worktreeId, tabs.add(pane.tabId))
    return () => {
      releaseCreate?.()
      tabs.delete(pane.tabId)
      if (tabs.size === 0) {
        this.byWorktree.delete(pane.worktreeId)
      }
      this.onEnded(pane.worktreeId)
    }
  }

  tabIds(worktreeId: string): ReadonlySet<string> {
    return this.byWorktree.get(worktreeId) ?? new Set()
  }
}
