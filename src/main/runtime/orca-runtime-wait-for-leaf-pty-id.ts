// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRestoreLivePairedRendererSessionOwnedMobileTerminals } from './orca-runtime-restore-live-paired-renderer-session-owned-mobile-terminals'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

export class OrcaRuntimeWithWaitForLeafPtyId extends OrcaRuntimeWithRestoreLivePairedRendererSessionOwnedMobileTerminals {
  replaceHeadlessTerminalFromRendererSnapshotForRecovery(
    ptyId: string,
    snapshot: {
      data: string
      cols: number
      rows: number
      cwd?: string | null
      oscLinks?: TerminalOscLinkRange[]
    },
    trailingOutput: { data: string; seq: number }[] = []
  ): void {
    if (!snapshot.data) {
      return
    }
    // Why: a redraw byte can create a suffix-only model before the renderer settles; replace it with the exact snapshot already sent mobile.
    this.providerSnapshotPreferredPtys.add(ptyId)
    this.disposeHeadlessTerminal(ptyId)
    this.seedHeadlessTerminal(
      ptyId,
      snapshot.data,
      { cols: snapshot.cols, rows: snapshot.rows },
      { cwd: snapshot.cwd, oscLinks: snapshot.oscLinks }
    )
    // Why: a hidden pane answers at its own size; later bytes paint the PTY grid.
    const ptyGrid = this.getTerminalSize(ptyId)
    if (ptyGrid) {
      this.resizeHeadlessTerminal(ptyId, ptyGrid.cols, ptyGrid.rows)
    }
    for (const chunk of trailingOutput) {
      this.trackHeadlessTerminalData(ptyId, chunk.data, chunk.seq)
    }
    // The seed's write chain owns subsequent live bytes; suppress on-data hydration from replacing this known-good seed.
    this.headlessHydrationState.set(ptyId, 'done')
  }
}
