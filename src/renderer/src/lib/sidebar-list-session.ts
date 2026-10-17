import { isPairedWebClientWindow } from './desktop-window-chrome'

/**
 * Tells main the window mounted its list, so main's Smart latch and sleeping retention start cold
 * as the window's do. A paired web client's list is its own view and never resets the host's.
 */
export function beginSidebarListSession(sessionId: string): void {
  if (isPairedWebClientWindow() || typeof window.api?.runtime?.call !== 'function') {
    return
  }
  void window.api.runtime
    .call({ method: 'sidebarSession.begin', params: { sessionId } })
    .catch(() => {})
}
