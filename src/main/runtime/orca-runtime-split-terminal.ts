// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from './orca-runtime-stop-explicitly-closed-tab-ptys'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../shared/runtime-types'
import type { Worktree } from '../../shared/worktree/types'
import { randomUUID } from 'node:crypto'
import { waitForHeldPaneTerminal } from './held-pane-terminal-wait'

export class OrcaRuntimeWithSplitTerminal extends OrcaRuntimeWithStopExplicitlyClosedTabPtys {
  async splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    const live = this.getLivePtyForHandle(handle)
    if (live) {
      return await this.splitPtyBackedTerminal(live.pty, opts, createdWorktree)
    }
    // A window terminal's handle names its leaf. Main split it in the window, which moved nothing.
    const { leaf } = this.getLiveLeafForHandle(handle)
    const pty = leaf.ptyId ? this.ptysById.get(leaf.ptyId) : undefined
    const split = pty?.connected
      ? await this.splitPtyBackedTerminal(pty, { ...opts, activate: false }, createdWorktree)
      : await this.splitUnstartedLeaf(leaf, opts)
    return { ...split, paneRuntimeId: leaf.paneRuntimeId }
  }

  /** A pane still starting or kept after its exit: the layout splits it and starts the new pane. */
  private async splitUnstartedLeaf(
    leaf: { worktreeId: string; tabId: string; leafId: string },
    opts: { direction?: 'horizontal' | 'vertical'; command?: string; env?: Record<string, string> }
  ): Promise<RuntimeTerminalSplit> {
    // The layout's start runs the tab's shell; a command or environment needs the spawn path.
    if (opts.command || opts.env) {
      throw new Error('terminal_handle_stale')
    }
    const location = this.layoutHolder.findTerminalTab(leaf.tabId)
    if (!location) {
      throw new Error('terminal_handle_stale')
    }
    const newLeafId = randomUUID()
    const ptyId = await waitForHeldPaneTerminal(
      this.layoutHolder,
      { workspace: location.workspace, tabId: leaf.tabId, leafId: newLeafId },
      () =>
        this.layoutCommands.apply(
          {
            type: 'splitPane',
            workspace: location.workspace,
            tabId: location.tabId,
            leafId: leaf.leafId,
            direction: opts.direction ?? 'horizontal',
            newLeafId
          },
          { viewId: null }
        ).ok,
      { askFirst: true }
    )
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    if (!pty) {
      throw new Error('terminal_handle_stale')
    }
    return {
      handle: this.issuePtyHandle(pty),
      tabId: leaf.tabId,
      paneRuntimeId: -1,
      leafId: newLeafId
    }
  }
}
