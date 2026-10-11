import {
  NEWER_DAEMON_RELEASED_CHANNEL,
  type NewerDaemonHold,
  type NewerDaemonReopenResult
} from '../../../../shared/newer-daemon-hold'
import {
  readNewerDaemonHold,
  reopenNewerDaemonTerminals
} from '../../../daemon/daemon-newer-protocol-hold'
import { getPtyIpc } from '../../pty-host-bindings'
import type { PtyRendererDelivery } from '../session'

// Why the PTY delivery window: terminal panes live only in the renderer that receives pty events.
function announceNewerDaemonReleased(mainWindow: PtyRendererDelivery | undefined): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(NEWER_DAEMON_RELEASED_CHANNEL)
  }
}

export function installPtyNewerDaemonHoldIpcHandlers(mainWindow?: PtyRendererDelivery): void {
  const ipcMain = getPtyIpc()
  ipcMain.handle(
    'pty:readNewerDaemonHold',
    (_event, args: { sessionId: string }): Promise<NewerDaemonHold> =>
      typeof args?.sessionId === 'string'
        ? readNewerDaemonHold(args.sessionId)
        : Promise.resolve({ held: false })
  )
  ipcMain.handle('pty:reopenNewerDaemonTerminals', async (): Promise<NewerDaemonReopenResult> => {
    const result = await reopenNewerDaemonTerminals()
    if (result.reopened) {
      announceNewerDaemonReleased(mainWindow)
    }
    return result
  })
}
