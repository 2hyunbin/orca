// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from './orca-runtime-stop-explicitly-closed-tab-ptys'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../shared/runtime-types'
import type { Worktree } from '../../shared/worktree/types'

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
    // A window terminal's handle names its leaf; the split runs on the PTY that leaf shows.
    const pty =
      this.getLivePtyForHandle(handle)?.pty ??
      this.ptysById.get(this.getLiveLeafForHandle(handle).leaf.ptyId ?? '')
    if (!pty) {
      throw new Error('terminal_handle_stale')
    }
    return await this.splitPtyBackedTerminal(pty, opts, createdWorktree)
  }
}
