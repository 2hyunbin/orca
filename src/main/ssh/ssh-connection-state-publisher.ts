import type { SshConnectionState } from '../../shared/ssh-types'
import { projectSshConnectionReadiness } from './ssh-connection-readiness'
import { testingTargets } from '../ipc/ssh-connect-attempt-registry'
import { getCurrentMainWindow } from '../ipc/ssh-ipc-context'
import { restoreManagedHostPortForwards } from '../ipc/ssh-managed-port-forward-restore'
import { broadcastSshState } from '../ipc/ssh-renderer-broadcast'

export function handleSshConnectionStateChange(targetId: string, state: SshConnectionState): void {
  if (testingTargets.has(targetId)) {
    return
  }
  const published = projectSshConnectionReadiness(targetId, state)
  broadcastSshState(getCurrentMainWindow, targetId, published)
  // An explicit connect restores through its own publish; this covers a transport that recovered.
  if (published.status === 'connected') {
    void restoreManagedHostPortForwards(targetId)
  }
}
