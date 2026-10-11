import { OrcaRuntimeWithPreparePtyExecutionContext } from './orca-runtime-prepare-pty-execution-context'

export class OrcaRuntimeWithOnPtyData extends OrcaRuntimeWithPreparePtyExecutionContext {
  /** Arrival-order mode scan: the settled tracker plus any in-flight snapshot capture's. */
  protected scanProviderModeTrackers(ptyId: string, data: string): void {
    return this.terminalOutput.scanProviderModeTrackers(ptyId, data)
  }

  onPtyData(
    ptyId: string,
    data: string,
    at: number,
    sequenceChars = data.length,
    transformed = false
  ): number {
    return this.terminalOutput.onPtyData(ptyId, data, at, sequenceChars, transformed)
  }
}
