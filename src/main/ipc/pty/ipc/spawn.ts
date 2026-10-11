import { getPtyIpc } from '../../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/newer-daemon-hold'
import {
  hasNewerProtocolDaemonHold,
  isSessionHeldByNewerDaemon
} from '../../../daemon/daemon-newer-protocol-hold'
import { getDaemonProvider } from '../../../daemon/daemon-provider-state'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps

  ipcMain.handle('pty:spawn', async (_event, args: PtySpawnIpcArgs) => {
    const hostId = getConnectionExecutionHostId(args.connectionId)
    const startupPromise = getLocalPtyStartupPromise(hostId)
    if (startupPromise) {
      await startupPromise
    }
    // Why before any spawn: restoring here would start a second shell, and agent, beside the
    // newer build's still-running one. The renderer holds the pane on this marker.
    if (
      args.sessionId &&
      hostId === LOCAL_EXECUTION_HOST_ID &&
      hasNewerProtocolDaemonHold() &&
      (await isSessionHeldByNewerDaemon(args.sessionId, getDaemonProvider()))
    ) {
      throw new Error(NEWER_DAEMON_HOLD_ERROR)
    }
    return runPtyIpcSpawn(deps, args)
  })
}
