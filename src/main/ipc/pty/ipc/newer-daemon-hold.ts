import type { NewerDaemonReopenResult } from '../../../../shared/newer-daemon-hold'
import { reopenNewerDaemonTerminals } from '../../../daemon/daemon-newer-protocol-hold'
import { getPtyIpc } from '../../pty-host-bindings'

export function installPtyNewerDaemonHoldIpcHandlers(): void {
  getPtyIpc().handle('pty:reopenNewerDaemonTerminals', (): Promise<NewerDaemonReopenResult> =>
    reopenNewerDaemonTerminals()
  )
}
