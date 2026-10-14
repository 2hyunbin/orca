import type { SshConnectionState } from '../../shared/ssh-types'
import { isSshHostCensusInFlight } from './ssh-connection-attribution'
import { connectInFlight, testingTargets } from '../ipc/ssh-connect-attempt-registry'
import { getCurrentMainWindow } from '../ipc/ssh-ipc-context'
import { restoreManagedHostPortForwards } from '../ipc/ssh-managed-port-forward-restore'
import { broadcastSshState } from '../ipc/ssh-renderer-broadcast'

export function handleSshConnectionStateChange(targetId: string, state: SshConnectionState): void {
  if (testingTargets.has(targetId)) {
    return
  }
  if (
    state.status === 'connected' &&
    (connectInFlight.has(targetId) || isSshHostCensusInFlight(targetId))
  ) {
    // Why: the raw transport reaches 'connected' while the connect is still deciding the host's
    // server; forwarding it would let the renderer treat the host as up before anything serves it.
    broadcastSshState(getCurrentMainWindow, targetId, {
      targetId,
      status: 'connecting',
      error: state.error,
      reconnectAttempt: state.reconnectAttempt
    })
    return
  }
  broadcastSshState(getCurrentMainWindow, targetId, state)
  // An explicit connect restores through its own publish; this covers a transport that recovered.
  if (state.status === 'connected') {
    void restoreManagedHostPortForwards(targetId)
  }
}
