// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { TerminalLayoutCommands } from './terminal/layout/terminal-layout-commands'
import { OrcaRuntimeWithGetOrchestrationDispatchAuthority } from './orca-runtime-get-orchestration-dispatch-authority'

export class OrcaRuntimeWithHasRecentTerminalOutputPath extends OrcaRuntimeWithGetOrchestrationDispatchAuthority {
  hasRecentTerminalOutputPath(handle: string, pathText: string, absolutePath: string): boolean {
    return this.terminalOutput.hasRecentTerminalOutputPath(handle, pathText, absolutePath)
  }

  // ─── Mobile Fit Override Management ─────────────────────────

  // Why: legacy mobile RPC entrypoint. After the state-machine rewrite this
  // is a thin shim that computes a `PtyLayoutTarget` and routes through
  // `enqueueLayout`. Keeps the same observable return shape so older mobile
  // builds continue to work. See docs/mobile-terminal-layout-state-machine.md.
  resizeForClient(
    ...args: Parameters<TerminalLayoutCommands['resizeForClient']>
  ): ReturnType<TerminalLayoutCommands['resizeForClient']> {
    return this.terminalLayout.commands.resizeForClient(...args)
  }

  getTerminalFitOverride(
    ...args: Parameters<TerminalLayoutCommands['getTerminalFitOverride']>
  ): ReturnType<TerminalLayoutCommands['getTerminalFitOverride']> {
    return this.terminalLayout.commands.getTerminalFitOverride(...args)
  }

  getAllTerminalFitOverrides(
    ...args: Parameters<TerminalLayoutCommands['getAllTerminalFitOverrides']>
  ): ReturnType<TerminalLayoutCommands['getAllTerminalFitOverrides']> {
    return this.terminalLayout.commands.getAllTerminalFitOverrides(...args)
  }

  getAllTerminalDrivers(
    ...args: Parameters<TerminalLayoutCommands['getAllTerminalDrivers']>
  ): ReturnType<TerminalLayoutCommands['getAllTerminalDrivers']> {
    return this.terminalLayout.commands.getAllTerminalDrivers(...args)
  }

  getBrowserRemoteViewerPages(): string[] {
    return this.edgeCommands.getBrowserRemoteViewerPages()
  }
}
