import type * as Electron from 'electron'

const {
  contextBridge,
  ipcRenderer
}: Pick<typeof Electron, 'contextBridge' | 'ipcRenderer'> = require('electron')

contextBridge.exposeInMainWorld(
  'orcaFileViewerHost',
  Object.freeze({
    initialize: (): Promise<unknown> => ipcRenderer.invoke('plugins:viewerInitialize'),
    read: (request: unknown): Promise<unknown> => ipcRenderer.invoke('plugins:viewerRead', request),
    copySelection: (): Promise<unknown> => ipcRenderer.invoke('plugins:viewerCopySelection'),
    notify: (status: unknown): void => ipcRenderer.sendToHost('plugin-viewer:status', status)
  })
)
