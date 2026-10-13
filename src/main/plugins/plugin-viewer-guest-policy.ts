import type { WebContents } from 'electron'
import type { PluginViewerSessionLease } from './plugin-viewer-session-pool'
import { bindPluginViewerGuest, retirePluginViewerSession } from './plugin-viewer-session-runtime'

export function installPluginViewerGuestPolicy(
  guest: WebContents,
  host: WebContents,
  lease: PluginViewerSessionLease<Electron.Session>
): () => void {
  if (!bindPluginViewerGuest(lease, host.id, guest)) {
    guest.close({ waitForBeforeUnload: false })
    return () => {}
  }
  guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  // The watchdog and host-owned surface must keep painting while the window is hidden.
  guest.setBackgroundThrottling(false)
  guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  const navigate = (event: Electron.Event): void => event.preventDefault()
  const retire = (): void => {
    void retirePluginViewerSession(lease.id).catch(() => {
      // Cleanup failure quarantines the private slot; authority is already withdrawn.
    })
  }
  guest.on('will-navigate', navigate)
  guest.on('will-frame-navigate', navigate)
  guest.once('destroyed', retire)
  guest.once('render-process-gone', retire)
  return () => {
    guest.removeListener('will-navigate', navigate)
    guest.removeListener('will-frame-navigate', navigate)
    guest.removeListener('destroyed', retire)
    guest.removeListener('render-process-gone', retire)
    retire()
  }
}
