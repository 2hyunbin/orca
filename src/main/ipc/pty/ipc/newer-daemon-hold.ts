import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type { NewerDaemonHold, NewerDaemonReopenResult } from '../../../../shared/newer-daemon-hold'
import {
  readNewerDaemonHold,
  reopenNewerDaemonTerminals
} from '../../../daemon/daemon-newer-protocol-hold'
import { getDaemonProvider } from '../../../daemon/daemon-provider-state'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { getPtyIpc } from '../../pty-host-bindings'

type Deps = { getLocalPtyProviderStartupPromise: () => Promise<void> | undefined }

// Why local only: another host's terminal is held, or not, by that host's own daemon census.
export function installPtyNewerDaemonHoldIpcHandlers(deps: Deps): void {
  const ipcMain = getPtyIpc()
  ipcMain.handle(
    'pty:readNewerDaemonHold',
    async (_event, args: { sessionId: string }): Promise<NewerDaemonHold> => {
      const sessionId = args?.sessionId
      if (
        typeof sessionId !== 'string' ||
        isRemoteRuntimePtyId(sessionId) ||
        parseAppSshPtyId(sessionId)
      ) {
        return { held: false }
      }
      // Why: the census and the adopted inventory are both set by the daemon provider swap.
      await deps.getLocalPtyProviderStartupPromise()
      return readNewerDaemonHold(sessionId, getDaemonProvider())
    }
  )
  ipcMain.handle('pty:reopenNewerDaemonTerminals', (): Promise<NewerDaemonReopenResult> =>
    reopenNewerDaemonTerminals()
  )
}
