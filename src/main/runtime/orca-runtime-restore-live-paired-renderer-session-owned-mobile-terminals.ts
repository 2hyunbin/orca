// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithWaitForMobileTerminalSurface } from './orca-runtime-wait-for-mobile-terminal-surface'

export class OrcaRuntimeWithRestoreLivePairedRendererSessionOwnedMobileTerminals extends OrcaRuntimeWithWaitForMobileTerminalSurface {
  protected setPairedRendererSessionOwnership(ptyId: string, owned: boolean): void {
    if (owned) {
      this.pairedRendererSessionOwnedPtyIds.add(ptyId)
    } else {
      this.pairedRendererSessionOwnedPtyIds.delete(ptyId)
    }
  }
}
