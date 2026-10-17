import { isPairedWebClientWindow } from './desktop-window-chrome'
import { e2eConfig } from './e2e-config'

/**
 * Tells main the window mounted its list, so main's Smart latch and sleeping retention start cold
 * as the window's do. A paired web client's list is its own view and never resets the host's.
 * Only dev and test builds begin one while main's copy is compared and not yet used.
 */
export function beginSidebarListSession(sessionId: string): void {
  if (
    !(import.meta.env.DEV || e2eConfig.exposeStore) ||
    isPairedWebClientWindow() ||
    typeof window.api?.runtime?.call !== 'function'
  ) {
    return
  }
  void window.api.runtime
    .call({ method: 'sidebarSession.begin', params: { sessionId } })
    .catch(() => {})
}
