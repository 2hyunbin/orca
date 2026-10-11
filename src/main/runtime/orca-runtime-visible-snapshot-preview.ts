import { OrcaRuntimeWithCaptureProviderTerminalBuffer } from './orca-runtime-capture-provider-terminal-buffer'
import type { RuntimeTerminalProjection } from './orca-runtime-core'

import type {
  RuntimeHeadlessTerminal,
  RuntimeVisibleTerminalState
} from './runtime-terminal-state-records'

import type { RuledScreen } from './screen-input-veto'

export class OrcaRuntimeWithVisibleSnapshotPreview extends OrcaRuntimeWithCaptureProviderTerminalBuffer {
  protected visibleSnapshotPreview(ptyId: string, preview: string): Promise<string> {
    return this.terminalOutput.visibleSnapshotPreview(ptyId, preview)
  }

  protected readVisibleTerminalState(ptyId: string): Promise<RuntimeVisibleTerminalState | null> {
    return this.terminalOutput.readVisibleTerminalState(ptyId)
  }

  protected loadVisibleTerminalState(ptyId: string): Promise<RuntimeVisibleTerminalState | null> {
    return this.terminalOutput.loadVisibleTerminalState(ptyId)
  }

  protected readHeadlessVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    return this.terminalOutput.readHeadlessVisibleTerminalState(ptyId)
  }

  /** Synchronous visible grid of the live emulator, for tui-idle body evidence. Null when the
   *  model is not the whole screen: a provider-restored partial suffix or a pending hydration. */
  protected readLiveTerminalScreenLines(ptyId: string | null | undefined): string[] | null {
    return this.terminalOutput.readLiveTerminalScreenLines(ptyId)
  }

  /** The grid a screen-ruled agent's rule reads: as painted, and only on the PTY's own size. */
  protected readRuledScreen(ptyId: string | null | undefined): RuledScreen | null {
    return this.terminalOutput.readRuledScreen(ptyId)
  }

  protected readWholeScreenModel(ptyId: string | null | undefined): RuntimeHeadlessTerminal | null {
    return this.terminalOutput.readWholeScreenModel(ptyId)
  }

  protected parseVisibleSnapshot(snapshot: {
    data: string
    cols: number
    rows: number
  }): Promise<RuntimeTerminalProjection> {
    return this.terminalOutput.parseVisibleSnapshot(snapshot)
  }

  protected readRendererVisibleSnapshotLines(ptyId: string): Promise<RuntimeTerminalProjection> {
    return this.terminalOutput.readRendererVisibleSnapshotLines(ptyId)
  }
}
