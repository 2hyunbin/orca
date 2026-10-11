// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.

import { OrcaRuntimeWithHasRecentTerminalOutputPath } from './orca-runtime-has-recent-terminal-output-path'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'

export class OrcaRuntimeWithOnClientDisconnected extends OrcaRuntimeWithHasRecentTerminalOutputPath {
  onClientDisconnected(clientId: string): void {
    ;(this as RuntimeCommandSurfaceHost<this>).revokeTerminalFileGrantsForClient(clientId)
    this.mobileDictation.cancelForClient(clientId)
    this.terminalLayout.commands.onClientDisconnected(clientId)
  }
}
