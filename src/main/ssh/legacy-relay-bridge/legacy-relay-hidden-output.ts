/**
 * Bridged panes no visible view shows: their output stops here instead of crossing renderer IPC,
 * and the reveal re-reads the screen the relay kept, since main holds no model of these terminals.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import {
  EMPTY_OUTPUT_SALVAGE,
  salvageHiddenOutput,
  type OutputSalvageState
} from './legacy-relay-output-salvage'

export type LegacyRelayHiddenOutputDeps = {
  onData: (ptyId: string, data: string) => void
  /** A whole screen that replaces what the pane shows. */
  onReplay: (ptyId: string, replay: string) => void
  /**
   * Re-reads the relay's screen, calling `atSnapshot` in stream order with it. Never calling it
   * means the screen could not be read; the bridge then reattaches the pane with a full screen.
   */
  reread: (ptyId: string, atSnapshot: (replay: string) => void) => Promise<void>
}

/** Present while output is dropped; `revealing` once a view wants it and its screen is on the way. */
type HiddenPane = { dropped: boolean; revealing: boolean; salvage: OutputSalvageState }

export class LegacyRelayHiddenOutput {
  private readonly hidden = new Map<string, HiddenPane>()

  constructor(private readonly deps: LegacyRelayHiddenOutputDeps) {}

  onData(ptyId: string, data: string): void {
    const hidden = this.hidden.get(ptyId)
    if (!hidden) {
      this.deps.onData(ptyId, data)
      return
    }
    hidden.dropped = true
    const { kept, state } = salvageHiddenOutput(data, hidden.salvage)
    hidden.salvage = state
    if (kept) {
      this.deps.onData(ptyId, kept)
    }
  }

  setPaused(ptyId: string, paused: boolean): void {
    const hidden = this.hidden.get(ptyId)
    if (paused) {
      if (hidden) {
        hidden.revealing = false
      } else {
        this.hidden.set(ptyId, { dropped: false, revealing: false, salvage: EMPTY_OUTPUT_SALVAGE })
      }
      return
    }
    if (!hidden || hidden.revealing) {
      return
    }
    if (!hidden.dropped) {
      this.hidden.delete(ptyId)
      return
    }
    hidden.revealing = true
    void this.reveal(ptyId, hidden)
  }

  /** At an attach's snapshot: what was dropped before it is in the screen that attach returns. */
  screenSent(ptyId: string): void {
    const hidden = this.hidden.get(ptyId)
    if (hidden) {
      hidden.dropped = false
    }
  }

  forget(ptyId: string): void {
    this.hidden.delete(ptyId)
  }

  private async reveal(ptyId: string, pane: HiddenPane): Promise<void> {
    // Why output stays dropped until the snapshot: everything before it is in the screen, and the
    // screen must reach the window before anything printed after it.
    await this.deps
      .reread(ptyId, (replay) => {
        if (this.hidden.get(ptyId) === pane && pane.revealing) {
          this.hidden.delete(ptyId)
          this.deps.onReplay(ptyId, replay)
        }
      })
      .catch(() => {})
    if (this.hidden.get(ptyId) === pane && pane.revealing) {
      // Unreadable: the pane goes live again, and its reattach brings the whole screen.
      this.hidden.delete(ptyId)
      if (pane.salvage.tail && !pane.salvage.skippingOsc) {
        // A sequence split at the drop boundary; the next live chunk finishes it.
        this.deps.onData(ptyId, pane.salvage.tail)
      }
    }
  }
}
