import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { recordTerminalFreezeBreadcrumb } from '../terminal-freeze-breadcrumbs'
import { redactPtyIdForDiagnostics } from '../../../../../shared/pty-delivery-diagnostics'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Why this long: both resizes must reach the program as separate SIGWINCHs. Node's tty (Claude
// Code, Codex) re-reads the size on SIGWINCH and repaints only if it changed, so two resizes
// that land before it reads would look like none.
export const REMOTE_PROGRAM_REDRAW_RESTORE_MS = 250

/**
 * The one place a remote pane asks its program to repaint after the host could not give the
 * pane a screen image (#26887). An idle TUI only writes diffs, so without this the pane keeps
 * whatever frame it had before the disconnect until the user happens to resize.
 */
export function bindRemoteProgramRedraw(session: ConnectPanePtySession): void {
  session.remoteProgramRedrawRestore = null

  session.requestRemoteProgramRedraw = function (reason: string): void {
    const ptyId = session.transport.getPtyId()
    if (
      session.disposed ||
      !ptyId ||
      !isRemoteRuntimePtyId(ptyId) ||
      session.remoteProgramRedrawRestore !== null ||
      // Why: a hidden pane's grid is not authoritative, and a phone or another desktop that holds
      // the size must not have it taken; the repaint those viewers drive covers this pane too.
      !session.isRendererPtyResizeAuthoritative() ||
      session.shouldSuppressDesktopPtyResize()
    ) {
      return
    }
    const { cols, rows } = session.pane.terminal
    if (cols < 1 || rows < 2) {
      return
    }
    // Why rows, not cols: a height change does not rewrap the host's scrollback.
    if (!session.transport.resize(cols, rows - 1, { claim: true })) {
      return
    }
    recordTerminalFreezeBreadcrumb('remote-program-redraw', {
      id: redactPtyIdForDiagnostics(ptyId),
      reason
    })
    const restore = (): void => {
      clearTimeout(timer)
      session.remoteProgramRedrawRestore = null
      // Why not forwardPtyResize: this put the PTY one row short, so it must put it back even if
      // the pane was hidden meanwhile; only a viewer that took the size since owns it now.
      if (session.transport.getPtyId() !== ptyId || session.shouldSuppressDesktopPtyResize()) {
        return
      }
      session.transport.resize(session.pane.terminal.cols, session.pane.terminal.rows, {
        claim: true
      })
    }
    const timer = setTimeout(restore, REMOTE_PROGRAM_REDRAW_RESTORE_MS)
    session.remoteProgramRedrawRestore = restore
  }

  // Why flush rather than cancel: an unmount mid-nudge would otherwise strand the PTY a row short.
  session.flushRemoteProgramRedraw = function (): void {
    session.remoteProgramRedrawRestore?.()
  }
}
