import { ipcMain } from 'electron'
import type { SshIpcRegistrar } from './ssh-ipc-registration'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import {
  assertSshConnectsNotFenced,
  connectInFlight,
  runSshTestConnectionProbe
} from './ssh-connect-attempt-registry'
import { connectionManager } from './ssh-ipc-context'
import { errorMessage } from '../../../shared/error-message'
import { clearSshCredentialDeclined } from '../../ssh/ssh-credential-decline'

export function registerSshTestConnectionHandler(ipc: SshIpcRegistrar = ipcMain): void {
  ipc.handle('ssh:testConnection', async (_event, args: { targetId: string }) => {
    const target = getSshTargetRegistryStore()!.getTarget(args.targetId)
    if (!target) {
      throw new Error(`SSH target "${args.targetId}" not found`)
    }
    clearSshCredentialDeclined(args.targetId)

    // Probe disconnect would tear down an active connect; join its attempt instead.
    const inFlight = connectInFlight.get(args.targetId)
    if (inFlight) {
      try {
        const state = await inFlight.promise
        return { success: true, state }
      } catch (err) {
        return { success: false, error: errorMessage(err) }
      }
    }

    // Track probe completion so shutdown can join its otherwise sessionless transport.
    const probe = runSshTestConnectionProbe(args.targetId, async () => {
      // Do not open probe transports after the shutdown drain.
      assertSshConnectsNotFenced()
      // Probing a user-disconnected host must leave it disconnected.
      const conn = await connectionManager!.connect(target, { probe: true })
      const state = conn.getState()
      await connectionManager!.disconnect(args.targetId)
      return state
    })
    try {
      return { success: true, state: await probe }
    } catch (err) {
      return { success: false, error: errorMessage(err) }
    }
  })
}
