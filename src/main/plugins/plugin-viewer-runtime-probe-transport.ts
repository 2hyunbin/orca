import { ipcMain, webContents, type WebContents } from 'electron'
import { dirname } from 'node:path'
import { PluginViewerDocumentRegistry } from '../../shared/plugins/plugin-viewer-document-registry'
import { hasExclusivePluginViewerProcess } from './plugin-viewer-guest-watchdog'

export async function createViewerRuntimeProbeTransport(guest: WebContents, entryPath: string) {
  const owner = {
    executionHostId: 'local',
    workspaceId: 'folder-probe',
    clientId: 'desktop-probe',
    tabId: 'viewer-probe',
    pluginKey: 'probe.viewer',
    pluginGeneration: 1
  }
  let disposed = false
  const registry = new PluginViewerDocumentRegistry({
    isAuthorized: () =>
      !disposed && hasExclusivePluginViewerProcess(guest, webContents.getAllWebContents()),
    onCloseError() {
      throw new Error('probe document close failed')
    }
  })
  const document = await registry.create(owner, { boundaryPath: dirname(entryPath), entryPath })
  let reads = 0
  ipcMain.handle('viewer-probe:read', (event, request: unknown) => {
    if (disposed || event.sender !== guest || event.senderFrame !== guest.mainFrame) {
      return { ok: false, error: 'unauthorized' }
    }
    reads++
    return registry.read(owner, request)
  })
  return {
    document,
    get reads() {
      return reads
    },
    async dispose() {
      disposed = true
      ipcMain.removeHandler('viewer-probe:read')
      await registry.dispose()
    }
  }
}
