import { webContents, type WebContents } from 'electron'
import type { OpenedPluginViewer } from './plugin-viewer-native-guest-record'
import type { PluginViewerResourceGuard } from './plugin-viewer-resource-guard'
import type { PluginViewerRegistry } from './plugin-viewer-registry'
import { isBoundPluginViewerGuest } from './plugin-viewer-session-runtime'
import { hasExclusivePluginViewerProcess } from './plugin-viewer-guest-watchdog'

export function isPluginViewerNativeGuestCurrent(
  state: OpenedPluginViewer,
  guest: WebContents,
  resources: Pick<PluginViewerResourceGuard, 'isCurrent'>,
  viewers: Pick<PluginViewerRegistry, 'isCurrent'>,
  disposed: boolean
): boolean {
  return (
    !disposed &&
    !state.closed &&
    (!state.authority || state.authority.isCurrent()) &&
    !state.host.isDestroyed() &&
    !guest.isDestroyed() &&
    guest.getURL() === state.lease.url &&
    isBoundPluginViewerGuest(state.lease, guest) &&
    (state.pid === undefined || state.pid === guest.getOSProcessId()) &&
    (state.pid === undefined || resources.isCurrent(state.lease.id)) &&
    hasExclusivePluginViewerProcess(guest, webContents.getAllWebContents()) &&
    viewers.isCurrent(state.viewer.key, state.viewer.revision, state.viewer.generation)
  )
}
