import type { BrowserWindow } from 'electron'

export function updaterMainWindow(
  send: (channel: string, ...args: unknown[]) => void,
  isDestroyed: () => boolean = () => false,
  isWebContentsDestroyed: () => boolean = isDestroyed
): BrowserWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the updater reaches its window through destruction checks and webContents.send.
  return {
    isDestroyed,
    webContents: { send, isDestroyed: isWebContentsDestroyed }
  } as unknown as BrowserWindow
}
