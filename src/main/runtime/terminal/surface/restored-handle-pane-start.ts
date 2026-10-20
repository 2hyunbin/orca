// Layout-owner builds: a CLI or orchestration send, wait or read on a handle whose pane main holds
// with no terminal yet (a saved pane not started since restore) starts it through main's one
// starter, then acts on the started terminal.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { OrcaRuntimeWithGetTerminalInteractiveWait } from '../wait/terminal-interactive-wait'
import { startedMainTerminalSurfaces } from './main-terminal-surfaces'

export abstract class OrcaRuntimeWithRestoredHandlePaneStart extends OrcaRuntimeWithGetTerminalInteractiveWait {
  /** Starts the saved pane a handle names when it has no terminal yet; the handle then names it. */
  async startRestoredHandlePane(handle: string): Promise<void> {
    if (!ORCA_LAYOUT_OWNER_IS_MAIN || this.getLivePtyForHandle(handle)) {
      return
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (leaf.ptyId || !startedMainTerminalSurfaces(this)?.ownsWorkspace(leaf.worktreeId)) {
      return
    }
    const ptyId = await this.ensureRestoredPaneStarted({
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId
    })
    const pty = ptyId === null ? undefined : this.ptysById.get(ptyId)
    if (!ptyId || !pty) {
      throw new Error('terminal_not_found')
    }
    // Why: the caller's handle names the started terminal, beside any handle its start minted,
    // so this call and later ones reach it before main's layout records the pane's binding.
    this.handles.set(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: pty.worktreeId,
      tabId: `pty:${ptyId}`,
      leafId: `pty:${ptyId}`,
      ptyId,
      ptyGeneration: 0
    })
  }
}
