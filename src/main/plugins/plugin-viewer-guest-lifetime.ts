import { webContents, type WebContents } from 'electron'
import { PluginViewerDocumentError } from '../../shared/plugins/plugin-viewer-document'
import type { PluginViewerUnavailable } from '../../shared/plugins/plugin-viewer-unavailable'
import {
  startPluginViewerGuestWatchdog,
  hasExclusivePluginViewerProcess
} from './plugin-viewer-guest-watchdog'
import type { PluginViewerResourceGuard } from './plugin-viewer-resource-guard'

export function startPluginViewerGuestLifetime(input: {
  guest: WebContents
  host: WebContents
  leaseId: string
  resources: PluginViewerResourceGuard
  close(): Promise<void>
}): () => void {
  const { guest, host, leaseId, resources, close } = input
  const relayPid = guest.getOSProcessId()
  let failure: PluginViewerUnavailable['code'] = 'unavailable'
  const unavailable = (code: PluginViewerUnavailable['code']): void => {
    failure = code
    try {
      if (!host.isDestroyed()) {
        host.send('plugins:viewerUnavailable', { leaseId, code } satisfies PluginViewerUnavailable)
      }
    } catch {
      /* The host may already have withdrawn its renderer. */
    }
    void close().catch(() => {})
  }
  if (!resources.admit(leaseId, guest.id, unavailable, relayPid)) {
    throw new PluginViewerDocumentError(failure)
  }
  try {
    const watchdog = startPluginViewerGuestWatchdog(guest, {
      getPeerContents: () => webContents.getAllWebContents(),
      isAuthorized: () => resources.isCurrent(leaseId),
      canCrash: () => resources.isCurrent(leaseId, true),
      recover: () => {
        if (!resources.terminateChildren(leaseId)) {
          throw new Error('plugin_viewer_process_changed')
        }
        if (!guest.isDestroyed()) {
          if (
            guest.getOSProcessId() !== relayPid ||
            !hasExclusivePluginViewerProcess(guest, webContents.getAllWebContents())
          ) {
            throw new Error('plugin_viewer_process_changed')
          }
          guest.forcefullyCrashRenderer()
        }
      },
      probe: async (worldId) => {
        const main = guest.mainFrame
        const children = main.framesInSubtree.filter(
          (frame) =>
            frame.frameTreeNodeId !== main.frameTreeNodeId &&
            webContents.fromFrame(frame)?.id === guest.id
        )
        const results = await Promise.all([
          guest.executeJavaScriptInIsolatedWorld(worldId, [{ code: 'true' }]),
          // Child DOM is host-owned; authors execute only in dedicated workers.
          ...children.map((frame) => frame.executeJavaScript('true'))
        ])
        return results.every((result) => result === true)
      },
      onUnavailable: (reason) => unavailable(reason === 'unresponsive' ? reason : 'unauthorized')
    })
    const destroyed = (): void => {
      void close().catch(() => {})
    }
    guest.once('destroyed', destroyed)
    return () => {
      resources.release(leaseId)
      watchdog.dispose()
      guest.removeListener('destroyed', destroyed)
    }
  } catch (error) {
    resources.release(leaseId)
    throw error
  }
}
