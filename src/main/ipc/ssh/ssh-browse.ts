import type { SshIpcRegistrar } from './ssh-ipc-registration'
import { ipcMain } from 'electron'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import { browseSshDirectory, type RemoteBrowseResult } from '../../ssh/ssh-remote-directory-browse'

export function registerSshBrowseHandler(
  getConnectionManager: () => SshConnectionManager | null,
  ipc: SshIpcRegistrar = ipcMain
): void {
  ipc.removeHandler('ssh:browseDir')

  ipc.handle(
    'ssh:browseDir',
    (_event, args: { targetId: string; dirPath: string }): Promise<RemoteBrowseResult> =>
      browseSshDirectory(getConnectionManager(), args.targetId, args.dirPath)
  )
}
