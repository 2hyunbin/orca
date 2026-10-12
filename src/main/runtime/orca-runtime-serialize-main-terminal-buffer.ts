import { OrcaRuntimeWithNotifyRemoteTerminalViewPresenceChanged } from './orca-runtime-notify-remote-terminal-view-presence-changed'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { HeadlessSeedMetadata } from './runtime-terminal-state-records'

export abstract class OrcaRuntimeWithSerializeMainTerminalBuffer extends OrcaRuntimeWithNotifyRemoteTerminalViewPresenceChanged {
  serializeMainTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    pendingEscapeTailAnsi?: string
    terminalOwner?: 'shell'
  } | null> {
    return this.terminalOutput.serializeMainTerminalBuffer(ptyId, opts)
  }

  serializeHiddenOutputRecoveryBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    pendingEscapeTailAnsi?: string
    terminalOwner?: 'shell'
  } | null> {
    return this.terminalOutput.serializeHiddenOutputRecoveryBuffer(ptyId, opts)
  }

  clearTerminalBuffer(handle: string): Promise<{ handle: string; cleared: boolean }> {
    return this.terminalOutput.clearTerminalBuffer(handle)
  }

  resetTerminalInputModes(handle: string): Promise<{ handle: string; reset: boolean }> {
    return this.terminalOutput.resetTerminalInputModes(handle)
  }

  getTerminalSize(ptyId: string): { cols: number; rows: number } | null {
    return this.terminalOutput.getTerminalSize(ptyId)
  }

  // Why: a width reflow on a normal-buffer PTY must re-stream the full
  // scrollback to mobile so it rewraps at the new cols, but alternate-screen
  // TUIs (vim, Claude Code) own their repaint and have no scrollback — for
  // those the mobile client just resizes xterm geometry and consumes the
  // TUI's own redraw, so the resize re-stream must be skipped. Provider state
  // covers restored PTYs whose main-side emulator is only a partial suffix.
  isTerminalAlternateScreen(ptyId: string): boolean {
    return this.terminalOutput.isTerminalAlternateScreen(ptyId)
  }

  // Why: daemon-backed PTYs that the runtime adopted after an Orca relaunch
  // start with a fresh headless emulator that has zero scrollback, even though
  // the daemon's on-disk checkpoint and the desktop xterm both contain the
  // full prior history. Without this hydration, mobile subscribers see only
  // the bare current prompt because serializeHeadlessTerminalBuffer always
  // wins over the renderer-path fallback. Seeding the emulator with the
  // adapter's snapshot/cold-restore data makes mobile and desktop agree on
  // what scrollback is available.
  seedHeadlessTerminal(
    ptyId: string,
    data: string,
    size?: { cols: number; rows: number },
    metadata: HeadlessSeedMetadata = {}
  ): void {
    return this.terminalOutput.seedHeadlessTerminal(ptyId, data, size, metadata)
  }

  // Why: reattach/cold-restore/replay payloads arrive as spawn RPC results and
  // never pass through onPtyData, so after a relaunch the records backing
  // `terminal list`/`terminal read` stayed blank while the session was alive.
  // Seed semantics (applySeededAgentStatus precedent): write state only — no
  // waiters, no orchestration events, and no lastOutputAt, because restored
  // bytes are historical output, not fresh activity.
  seedTerminalRestoreTail(ptyId: string, restore: { text?: string; lastTitle?: string }): void {
    return this.terminalOutput.seedTerminalRestoreTail(ptyId, restore)
  }
}
