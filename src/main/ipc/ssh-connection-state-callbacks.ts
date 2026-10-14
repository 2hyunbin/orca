import type { SshConnectionCallbacks } from '../ssh/ssh-connection'
import { credentialRequestedForTarget } from './ssh-connect-attempt-registry'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { requestCredential } from './ssh-passphrase'
import { handleSshConnectionStateChange } from '../ssh/ssh-connection-state-publisher'

export { handleSshConnectionStateChange } from '../ssh/ssh-connection-state-publisher'

export function createSshConnectionCallbacks(): SshConnectionCallbacks {
  return {
    onCredentialRequest: (targetId, kind, detail, echo, signal) => {
      credentialRequestedForTarget.add(targetId)
      return requestCredential(getCurrentMainWindow, targetId, kind, detail, echo, signal)
    },
    onStateChange: handleSshConnectionStateChange
  }
}
