import { RuntimeWorkspaceRemovalSurface } from '../../workspaces/workspace-removal-surface'
import type { RuntimeTerminalRename } from '../../../../shared/runtime-types'
import type { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from '../../orca-runtime-transition-graph-reload-to-terminal-state'

export abstract class OrcaRuntimeWithTerminalTitleRename extends RuntimeWorkspaceRemovalSurface {
  protected abstract assertGraphReady(
    ...args: Parameters<OrcaRuntimeWithTransitionGraphReloadToTerminalState['assertGraphReady']>
  ): ReturnType<OrcaRuntimeWithTransitionGraphReloadToTerminalState['assertGraphReady']>

  async renameTerminal(handle: string, title: string | null): Promise<RuntimeTerminalRename> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      pty.pty.title = title
      // Why: a manual rename must outrank later agent OSC title updates (which
      // win by timestamp), so stamp it as the freshest title.
      pty.pty.titleUpdatedAt = Date.now()
      this.touchMobileSessionSnapshotsForPty(pty.pty.ptyId)
      // Why: without a renderer the rename only lived on the live pty and was
      // lost on restart. Persist customTitle so a headless rebuild keeps it.
      if (!this.notifier?.renameTerminal && pty.pty.tabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, pty.pty.tabId, title)
      }
      for (const leaf of this.leaves.values()) {
        if (leaf.ptyId === pty.pty.ptyId) {
          this.notifier?.renameTerminal(leaf.tabId, title)
          return { handle, tabId: leaf.tabId, title }
        }
      }
      const tabId = pty.pty.tabId ?? pty.record.tabId
      // A notifier can exist before its pane graph; retain the rename on the known tab.
      if (this.notifier?.renameTerminal && tabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, tabId, title)
        this.notifier.renameTerminal(tabId, title)
      }
      return { handle, tabId, title }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
  }
}
