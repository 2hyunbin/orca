import { OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer } from './orca-runtime-maybe-hydrate-headless-from-renderer'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'

export class OrcaRuntimeWithCreatePtyHeadlessTerminalState extends OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer {
  /** Shared factory for the per-PTY runtime emulators (seed, hydration, and
   *  lazy live-byte creation): wires the Phase-5 query-reply sink and the
   *  ConPTY DA1 override. The daemon emulator never goes through here. */
  protected createPtyHeadlessTerminalState(
    ptyId: string,
    dims: { cols: number; rows: number }
  ): RuntimeHeadlessTerminal {
    return this.terminalOutput.createPtyHeadlessTerminalState(ptyId, dims)
  }

  /** Phase-5 ConPTY DA1 retrofit (terminal-query-authority.md): invoked via
   *  markNativeWindowsConptyPty when the spawn mark lands after daemon stream
   *  data already created this PTY's emulator. Idempotent emulator-side. */
  protected ensureNativeWindowsConptyDa1Override(ptyId: string): void {
    return this.terminalOutput.ensureNativeWindowsConptyDa1Override(ptyId)
  }

  protected getOrCreateHeadlessTerminal(ptyId: string): RuntimeHeadlessTerminal {
    return this.terminalOutput.getOrCreateHeadlessTerminal(ptyId)
  }

  protected replaceHeadlessTerminalAfterExecutionContextChange(ptyId: string): void {
    return this.terminalOutput.replaceHeadlessTerminalAfterExecutionContextChange(ptyId)
  }

  protected resizeHeadlessTerminal(ptyId: string, cols: number, rows: number): void {
    return this.terminalOutput.resizeHeadlessTerminal(ptyId, cols, rows)
  }

  /** Public: reflow an already-created model onto a grid the PROVIDER proved — a reattach learns
   *  the live session's real size only from its spawn reply, after live bytes may have lazily
   *  created the model at the 80x24 default. Not onExternalPtyResize: nothing measured a pane
   *  here, so the renderer-geometry baselines behind mobile take-back must stay untouched. */
  reflowHeadlessTerminalToPtyGrid(ptyId: string, cols: number, rows: number): void {
    return this.terminalOutput.reflowHeadlessTerminalToPtyGrid(ptyId, cols, rows)
  }

  // Public: desktop-initiated clears (ipc/pty.ts) must also drop this mobile
  // mirror or a resubscribing mobile client resurrects the cleared scrollback.
  clearHeadlessTerminalBuffer(ptyId: string): Promise<void> {
    return this.terminalOutput.clearHeadlessTerminalBuffer(ptyId)
  }

  // Public: Reset Terminal must ground this model too; park/reveal and mobile restore from it.
  resetHeadlessTerminalInputModes(ptyId: string): Promise<void> {
    return this.terminalOutput.resetHeadlessTerminalInputModes(ptyId)
  }
}
