import { ipcMain } from 'electron'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export function registerPluginRendererHandler(
  channel: string,
  handler: Parameters<typeof ipcMain.handle>[1]
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      !isTrustedBrowserRenderer(event.sender)
    ) {
      throw new Error('Plugin management requires the trusted application window')
    }
    return handler(event, ...args)
  })
}
