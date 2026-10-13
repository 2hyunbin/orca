import { ipcMain } from 'electron'
import type { PluginService } from '../plugins/plugin-service'
import { PluginViewerNativeGuestCoordinator } from '../plugins/plugin-viewer-native-guest-coordinator'

let coordinator: PluginViewerNativeGuestCoordinator | undefined
let factory: (() => PluginViewerNativeGuestCoordinator) | undefined

export function registerPluginViewerGuestTransport(
  resolve: () => PluginViewerNativeGuestCoordinator | undefined
): () => void {
  ipcMain.handle('plugins:viewerInitialize', (event) => {
    const current = resolve()
    return current
      ? current.initialize(event.sender, event.senderFrame === event.sender.mainFrame)
      : { ok: false, error: 'unavailable' }
  })
  ipcMain.handle('plugins:viewerRead', (event, request: unknown) => {
    const current = resolve()
    return current
      ? current.read(event.sender, event.senderFrame === event.sender.mainFrame, request)
      : { ok: false, error: 'unavailable' }
  })
  ipcMain.handle('plugins:viewerCopySelection', (event) => {
    return (
      resolve()?.copySelection(event.sender, event.senderFrame === event.sender.mainFrame) ?? false
    )
  })
  return () => {
    ipcMain.removeHandler('plugins:viewerInitialize')
    ipcMain.removeHandler('plugins:viewerRead')
    ipcMain.removeHandler('plugins:viewerCopySelection')
  }
}

export function registerPluginViewerGuestHandlers(service: PluginService): void {
  factory = () =>
    new PluginViewerNativeGuestCoordinator({
      viewers: service.contentPacks.fileViewers,
      whenReady: () => service.whenReady(),
      onChanged: (listener) => service.onChanged(listener)
    })
  registerPluginViewerGuestTransport(() => coordinator)
}

export function getNativePluginViewerCoordinator(): PluginViewerNativeGuestCoordinator {
  if (!factory) {
    throw new Error('plugin_viewer_unavailable')
  }
  coordinator ??= factory()
  return coordinator
}

export async function disposePluginViewerGuests(): Promise<void> {
  factory = undefined
  await coordinator?.dispose()
}
