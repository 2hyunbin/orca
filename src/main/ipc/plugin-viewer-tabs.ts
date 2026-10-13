import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { PluginViewerDocumentError } from '../../shared/plugins/plugin-viewer-document'
import {
  pluginViewerGuestLeaseSchema,
  pluginViewerOpenRequestSchema,
  type PluginViewerOpenResponse
} from '../../shared/plugins/plugin-viewer-open'
import { createPluginViewerBootstrap } from '../plugins/plugin-viewer-bootstrap'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { resolvePluginViewerFileRoute } from './plugin-viewer-file-route'
import { getNativePluginViewerCoordinator } from './plugin-viewer-guests'

export function registerPluginViewerTabHandlers(store: Store): void {
  ipcMain.handle(
    'plugins:openViewerTab',
    async (event, raw: unknown): Promise<PluginViewerOpenResponse> => {
      if (!isTrustedBrowserRenderer(event.sender) || event.senderFrame !== event.sender.mainFrame) {
        return { ok: false, error: 'unauthorized' }
      }
      const request = pluginViewerOpenRequestSchema.safeParse(raw)
      if (!request.success) {
        return { ok: false, error: 'invalid_request' }
      }
      try {
        const route = await resolvePluginViewerFileRoute(
          store,
          request.data,
          app.getPath('userData')
        )
        const bootstrap = await createPluginViewerBootstrap(request.data.chrome)
        const lease = await getNativePluginViewerCoordinator().create({
          host: event.sender,
          owner: {
            executionHostId: request.data.executionHostId,
            workspaceId: request.data.workspaceId,
            tabId: request.data.tabId
          },
          viewerKey: request.data.viewerKey,
          ...route,
          bootstrap
        })
        return { ok: true, lease: { id: lease.id, partition: lease.partition, url: lease.url } }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof PluginViewerDocumentError ? error.code : 'unavailable'
        }
      }
    }
  )
  ipcMain.handle('plugins:closeViewerTab', async (event, raw: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      return
    }
    const request = pluginViewerGuestLeaseSchema.safeParse(raw)
    if (request.success) {
      await getNativePluginViewerCoordinator().closeForHost(request.data.id, event.sender.id)
    }
  })
}
