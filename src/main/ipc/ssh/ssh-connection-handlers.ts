import type { SshIpcRegistrar } from './ssh-ipc-registration'
import { ipcMain } from 'electron'
import {
  setSshTargetRegistryHandlers,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import { connectTarget } from './ssh-connect-flow'
import { connectionManager } from './ssh-ipc-context'
import { getPublicSshState } from './ssh-renderer-broadcast'
import { disconnectSshHostForUser } from './ssh-host-user-disconnect'
import { isSshCredentialDeclined } from '../../ssh/ssh-credential-decline'
import { registerSshTestConnectionHandler } from './ssh-test-connection'

export function registerSshConnectionHandlers(ipc: SshIpcRegistrar = ipcMain): void {
  registerSshTestConnectionHandler(ipc)
  setSshTargetRegistryHandlers({
    connect: connectTarget,
    getState: (targetId: string) => getPublicSshState(targetId)
  })

  ipc.handle('ssh:connect', async (_event, args: { targetId: string; automatic?: boolean }) => {
    return connectTarget(args.targetId, { automatic: args.automatic === true })
  })

  ipc.handle('ssh:disconnect', async (_event, args: { targetId: string }) => {
    await disconnectSshHostForUser(args.targetId)
  })

  ipc.handle('ssh:getState', (_event, args: { targetId: string }) => {
    return getPublicSshState(args.targetId)
  })

  // Auto-connect callers need to avoid prompts when credentials were declined or are no longer cached.
  ipc.handle('ssh:needsPassphrasePrompt', (_event, args: { targetId: string }) => {
    if (isSshCredentialDeclined(args.targetId)) {
      return true
    }
    const target = getSshTargetRegistryStore()!.getTarget(args.targetId)
    if (!target?.lastRequiredPassphrase) {
      return false
    }
    return !connectionManager!.hasCachedCredential(target)
  })
}
