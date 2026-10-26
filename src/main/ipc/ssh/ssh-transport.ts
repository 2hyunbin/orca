import { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import {
  getSshTargetRegistryStore,
  setSshConnectionManagerResolver,
  setSshTargetRegistryStore,
  setSshTargetRegistryHandlers
} from '../../ssh/targets/ssh-target-registry'
import { resetSshConnectionGenerations } from '../../ssh/connection/ssh-connection-generation'
import { resetSshProviderAuthorities } from '../../ssh/ssh-provider-authority'
import { resetSshCredentialDeclinesForTests } from '../../ssh/ssh-credential-decline'
import { resetSshUserDisconnectsForTests } from '../../ssh/ssh-user-disconnect'
import {
  connectInFlight,
  credentialRequestedForTarget,
  testConnectionProbes,
  testingTargets
} from './ssh-connect-attempt-registry'
import { targetLifecycleInFlight } from './ssh-target-lifecycle-queue'
import {
  connectionManager,
  setConnectionManager,
  setCurrentGetMainWindow,
  setCurrentRuntime,
  setPersistedStore
} from './ssh-ipc-context'
import { createSshTransportCallbacks } from './ssh-transport-callbacks'
import { awaitSignInForCredentialHosts } from './ssh-sign-in-requirement'
import { createSshIpcRegistration } from './ssh-ipc-registration'
import { registerSshTestConnectionHandler } from './ssh-test-connection'
import { registerQuitTask } from '../../quit-task-registry'
import { beginSshShutdown, resetSshShutdownDrain } from './ssh-shutdown-drain'

export function initializeSshTransport() {
  registerQuitTask('ssh', 'ssh', beginSshShutdown)
  if (!connectionManager) {
    setConnectionManager(new SshConnectionManager(createSshTransportCallbacks()))
    // Window re-registration must not re-gate hosts already signed in during this process.
    awaitSignInForCredentialHosts(getSshTargetRegistryStore()!)
  }
  const registration = createSshIpcRegistration()
  registerSshTestConnectionHandler(registration.ipc)
  return registration
}

export async function resetSshTransportStateForTests(): Promise<void> {
  connectInFlight.clear()
  targetLifecycleInFlight.clear()
  resetSshConnectionGenerations()
  resetSshProviderAuthorities()
  testingTargets.clear()
  testConnectionProbes.clear()
  credentialRequestedForTarget.clear()
  resetSshCredentialDeclinesForTests()
  resetSshUserDisconnectsForTests()
  resetSshShutdownDrain()

  await connectionManager?.disconnectAll()
  setConnectionManager(null)
  setSshConnectionManagerResolver(null)
  setSshTargetRegistryStore(null)
  setPersistedStore(null)
  setSshTargetRegistryHandlers({ connect: null, getState: null })
  setCurrentGetMainWindow(() => null)
  setCurrentRuntime(undefined)
}
