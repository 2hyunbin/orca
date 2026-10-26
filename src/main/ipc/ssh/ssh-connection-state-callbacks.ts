import type { SshConnectionCallbacks } from '../../ssh/connection/ssh-connection-callbacks'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { isSshHostCensusInFlight } from '../../ssh/connection/ssh-connection-attribution'
import { connectInFlight, testingTargets } from './ssh-connect-attempt-registry'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { restoreManagedHostPortForwards } from './ssh-managed-port-forward-restore'
import { broadcastSshState } from './ssh-renderer-broadcast'
import { createSshTransportCallbacks, recordSshTransportState } from './ssh-transport-callbacks'

export function handleSshConnectionStateChange(targetId: string, state: SshConnectionState): void {
  recordSshTransportState(targetId, state)
  if (testingTargets.has(targetId)) {
    return
  }
  if (
    state.status === 'connected' &&
    (connectInFlight.has(targetId) || isSshHostCensusInFlight(targetId))
  ) {
    // Raw transport connected is premature while the host server decision is still pending.
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

export function createSshConnectionCallbacks(): SshConnectionCallbacks {
  return {
    ...createSshTransportCallbacks(),
    onStateChange: handleSshConnectionStateChange
  }
}
