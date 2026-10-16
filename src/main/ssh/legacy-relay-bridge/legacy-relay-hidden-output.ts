/**
 * Bridged panes no visible view shows: their output stops here instead of crossing renderer IPC,
 * and the reveal re-reads the screen the relay kept, since main holds no model of these terminals.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
export type LegacyRelayHiddenOutputDeps = {
  onData: (ptyId: string, data: string) => void
  /** A whole screen that replaces what the pane shows. */
  onReplay: (ptyId: string, replay: string) => void
  /** The relay's screen now, or null when it can't be read; the bridge then reattaches the pane. */
  reread: (ptyId: string) => Promise<string | null>
}

export class LegacyRelayHiddenOutput {
  private readonly hidden = new Map<string, { dropped: boolean }>()

  constructor(private readonly deps: LegacyRelayHiddenOutputDeps) {}

  onData(ptyId: string, data: string): void {
    const hidden = this.hidden.get(ptyId)
    if (hidden) {
      hidden.dropped = true
      return
    }
    this.deps.onData(ptyId, data)
  }

  setPaused(ptyId: string, paused: boolean): void {
    if (paused) {
      if (!this.hidden.has(ptyId)) {
        this.hidden.set(ptyId, { dropped: false })
      }
      return
    }
    const dropped = this.hidden.get(ptyId)?.dropped === true
    this.hidden.delete(ptyId)
    if (dropped) {
      void this.reveal(ptyId)
    }
  }

  /** An attach just answered with the whole screen, so nothing dropped before it is missing. */
  screenSent(ptyId: string): void {
    const hidden = this.hidden.get(ptyId)
    if (hidden) {
      hidden.dropped = false
    }
  }

  forget(ptyId: string): void {
    this.hidden.delete(ptyId)
  }

  private async reveal(ptyId: string): Promise<void> {
    const replay = await this.deps.reread(ptyId).catch(() => null)
    if (replay === null) {
      return
    }
    const hiddenAgain = this.hidden.get(ptyId)
    if (hiddenAgain) {
      // Hidden before the screen arrived: the next reveal reads a newer one.
      hiddenAgain.dropped = true
      return
    }
    this.deps.onReplay(ptyId, replay)
  }
}
