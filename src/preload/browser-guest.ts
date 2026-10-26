import type { ContextBridge, IpcRenderer } from 'electron'
import { installBrowserPasswordDetector } from './browser-password-detector'
import {
  installBrowserWindowCloseGuard,
  PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL
} from './browser-window-close-installation'

// Raw require keeps the sandboxed preload standalone in the CJS build.
const {
  contextBridge,
  ipcRenderer
}: { contextBridge: ContextBridge; ipcRenderer: IpcRenderer } = require('electron')

contextBridge.executeInMainWorld({
  func: installBrowserWindowCloseGuard,
  args: [() => ipcRenderer.sendToHost(PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL)]
})

// Why no contextBridge exposure: page script must not be able to call into the detector.
installBrowserPasswordDetector({
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  on: (channel, listener) => {
    ipcRenderer.on(channel, (_event, payload: unknown) => listener(payload))
  }
})
