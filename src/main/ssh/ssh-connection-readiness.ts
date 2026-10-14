import type { SshConnectionState } from '../../shared/ssh-types'
import { connectInFlight } from '../ipc/ssh-connect-attempt-registry'
import { isSshHostCensusInFlight } from './ssh-connection-attribution'

export function projectSshConnectionReadiness(
  targetId: string,
  state: SshConnectionState
): SshConnectionState {
  if (
    state.status === 'connected' &&
    (connectInFlight.has(targetId) || isSshHostCensusInFlight(targetId))
  ) {
    return {
      targetId,
      status: 'connecting',
      error: state.error,
      reconnectAttempt: state.reconnectAttempt
    }
  }
  return state
}
