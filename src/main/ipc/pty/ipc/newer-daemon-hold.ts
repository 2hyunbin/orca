import type { NewerDaemonHold, NewerDaemonReopenResult } from '../../../../shared/newer-daemon-hold'
import {
  readNewerDaemonHold,
  reopenNewerDaemonTerminals
} from '../../../daemon/daemon-newer-protocol-hold'
import { getPtyIpc } from '../../pty-host-bindings'

export function installPtyNewerDaemonHoldIpcHandlers(): void {
  const ipcMain = getPtyIpc()
  ipcMain.handle(
    'pty:readNewerDaemonHold',
    (_event, args: { sessionId: string }): Promise<NewerDaemonHold> =>
      typeof args?.sessionId === 'string'
        ? readNewerDaemonHold(args.sessionId)
        : Promise.resolve({ held: false })
  )
  ipcMain.handle('pty:reopenNewerDaemonTerminals', (): Promise<NewerDaemonReopenResult> =>
    reopenNewerDaemonTerminals()
  )
}
