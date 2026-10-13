import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('viewerProbe', {
  read(request: unknown): Promise<unknown> {
    return ipcRenderer.invoke('viewer-probe:read', request)
  }
})
