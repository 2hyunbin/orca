import type { SshConnectionCallbacks } from '../../ssh/connection/ssh-connection-callbacks'
import type { SshConnectionState } from '../../../shared/ssh-types'
import {
  clearSshCredentialDeclined,
  isSshCredentialDeclined
} from '../../ssh/ssh-credential-decline'
import { credentialRequestedForTarget } from './ssh-connect-attempt-registry'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { recordSshSignInRequirement } from './ssh-sign-in-requirement'
import { requestCredential } from './ssh-passphrase'

export function recordSshTransportState(targetId: string, state: SshConnectionState): void {
  if (state.status === 'connected') {
    clearSshCredentialDeclined(targetId)
    recordSshSignInRequirement(targetId, getSshTargetRegistryStore(), connectionManager)
  }
}

export function createSshTransportCallbacks(): SshConnectionCallbacks {
  return {
    onCredentialRequest: (targetId, kind, detail, echo, signal) => {
      // After Cancel, only explicit connects may prompt again.
      if (isSshCredentialDeclined(targetId, signal)) {
        return Promise.resolve(null)
      }
      credentialRequestedForTarget.add(targetId)
      return requestCredential(getCurrentMainWindow, targetId, kind, detail, echo, signal)
    },
    onStateChange: recordSshTransportState
  }
}
