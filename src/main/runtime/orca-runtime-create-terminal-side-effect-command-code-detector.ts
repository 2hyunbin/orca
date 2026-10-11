import { OrcaRuntimeWithApplyTrackedPtyTitle } from './orca-runtime-apply-tracked-pty-title'
import type {
  RuntimePtyTitleTrackerEntry,
  RuntimePtyWorktreeRecord
} from './runtime-terminal-state-records'

import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'

export abstract class OrcaRuntimeWithCreateTerminalSideEffectCommandCodeDetector extends OrcaRuntimeWithApplyTrackedPtyTitle {
  protected createTerminalSideEffectCommandCodeDetector(
    ptyId: string
  ): NonNullable<RuntimePtyTitleTrackerEntry['commandCodeDetector']> {
    return this.terminalOutput.createTerminalSideEffectCommandCodeDetector(ptyId)
  }

  protected extractLastOsc7CwdForPty(
    ptyId: string,
    data: string
  ): { path: string; hostname: string } | null {
    return this.terminalOutput.extractLastOsc7CwdForPty(ptyId, data)
  }

  protected recordOsc7MetadataForPty(
    ptyId: string,
    data: string
  ): { cwd: string | null; cwdChanged: boolean } {
    return this.terminalOutput.recordOsc7MetadataForPty(ptyId, data)
  }

  protected pathFlavorForPty(pty?: RuntimePtyWorktreeRecord | null): 'posix' | 'win32' {
    return this.terminalOutput.pathFlavorForPty(pty)
  }

  protected emitTerminalAgentStatusEvents(
    ptyId: string,
    chunk: Pick<ProcessedAgentStatusChunk, 'payloads'>,
    provenance?: { origin: 'process'; yieldsToHookSince: number }
  ): void {
    return this.terminalOutput.emitTerminalAgentStatusEvents(ptyId, chunk, provenance)
  }
}
