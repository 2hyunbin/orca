import type { BrowserWindow } from 'electron'
import { createSshIpcRegistration, type SshIpcRegistrar } from './ssh-ipc-registration'
import type { Store } from '../../persistence'
import { awaitSignInForCredentialHosts } from './ssh-sign-in-requirement'
import { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import {
  getSshTargetRegistryStore,
  setSshConnectionManagerResolver,
  setSshTargetRegistryHandlers,
  setSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'

import { registerSshBrowseHandler } from './ssh-browse'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { resetSshConnectionGenerations } from '../../ssh/connection/ssh-connection-generation'
import { resetSshProviderAuthorities } from '../../ssh/ssh-provider-authority'
import { installManagedOrcadStartStatus } from '../runtime-environments/runtime-environment-managed-tunnel'
import {
  connectInFlight,
  credentialRequestedForTarget,
  testConnectionProbes,
  testingTargets
} from './ssh-connect-attempt-registry'
import { createSshConnectionCallbacks } from './ssh-connection-state-callbacks'
import { resetSshCredentialDeclinesForTests } from '../../ssh/ssh-credential-decline'
import { resetSshUserDisconnectsForTests } from '../../ssh/ssh-user-disconnect'
import { registerSshConnectionHandlers } from './ssh-connection-handlers'
import { registerPlainSshTerminalHandlers } from './plain-ssh-terminal-handlers'
import {
  registerPowerMonitorReconnect,
  unregisterPowerMonitorReconnect
} from './ssh-host-sleep-reconnect'
import {
  connectionManager,
  getCurrentMainWindow,
  portForwardManager,
  setConnectionManager,
  setCurrentGetMainWindow,
  setCurrentRuntime,
  setPersistedStore,
  setPortForwardManager
} from './ssh-ipc-context'
import { registerSshPortForwardHandlers } from './ssh-port-forward-handlers'
import { persistPortForwards } from './ssh-port-forward-persistence'
import { recordForwardFailure } from './ssh-port-forward-unrestored'
import { restoreManagedHostPortForwards } from './ssh-managed-port-forward-restore'
import { setSshHostServedListener } from '../../ssh/ssh-host-server-status'
import { broadcastPortForwards } from './ssh-renderer-broadcast'
import { registerQuitTask } from '../../quit-task-registry'
import { beginSshShutdown, resetSshShutdownDrain } from './ssh-shutdown-drain'
import { targetLifecycleInFlight } from './ssh-target-lifecycle-queue'
import { disposeOrcadManagedTunnels } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { retainUnretainedOrcadMigrationSources } from '../../ssh/orcad-migration-source-retention'
import { reconcileManagedOrcadSshTargets } from '../../ssh/orcad-retained-source'
import { installOrcadMigrationScrollbackRetention } from '../../ssh/orcad-migration-scrollback-retention-wiring'
import { getAppEnvironment } from '../../../shared/app-environment'
import {
  disposeDesktopBrowserBridge,
  installDesktopBrowserBridge
} from '../desktop-browser-bridge-wiring'

export function initializeSshMigrationState(store: Store): void {
  registerQuitTask('ssh', 'ssh', beginSshShutdown)
  reconcileManagedOrcadSshTargets(getAppEnvironment().getPath('userData'), store)
  void retainUnretainedOrcadMigrationSources(getAppEnvironment().getPath('userData'), store)
  installOrcadMigrationScrollbackRetention(getAppEnvironment().getPath('userData'), store)
}

export function initializeSshSubsystem(
  getMainWindow: () => BrowserWindow | null,
  runtime: OrcaRuntimeService | undefined,
  registerCompatibility: (ipc: SshIpcRegistrar) => void
) {
  registerQuitTask('ssh', 'ssh', beginSshShutdown)
  const registration = createSshIpcRegistration()
  const { ipc } = registration
  installManagedOrcadStartStatus()

  const callbacks = createSshConnectionCallbacks()
  if (connectionManager) {
    connectionManager.setCallbacks(callbacks)
  } else {
    setConnectionManager(new SshConnectionManager(callbacks))
    // Window re-registration must not re-gate hosts already signed in during this process.
    awaitSignInForCredentialHosts(getSshTargetRegistryStore()!)
  }
  setPortForwardManager(portForwardManager ?? new SshPortForwardManager())
  portForwardManager!.setCallbacks({
    onForwardClosed: (entry, reason) => {
      if (reason.kind === 'unexpected-exit') {
        console.warn(
          `[ssh] Port forward ${entry.localPort} → ${entry.remoteHost}:${entry.remotePort} closed unexpectedly${
            reason.detail ? `: ${reason.detail}` : ''
          }`
        )
        // An ssh that starts and later dies backs off like one that never started.
        recordForwardFailure(
          entry.connectionId,
          entry,
          reason.detail ?? 'exited unexpectedly',
          'exit'
        )
      }
      persistPortForwards(entry.connectionId)
      broadcastPortForwards(getCurrentMainWindow, entry.connectionId)
    }
  })
  // Every served status restores saved forwards, whichever path brought the host up.
  setSshHostServedListener((targetId) => void restoreManagedHostPortForwards(targetId))
  registerPowerMonitorReconnect(() => getAppEnvironment().getPath('userData'))
  registerSshBrowseHandler(() => connectionManager, ipc)
  setSshConnectionManagerResolver(() => connectionManager)

  registerSshConnectionHandlers(ipc)
  registerSshPortForwardHandlers(ipc)
  registerPlainSshTerminalHandlers(ipc)
  registerCompatibility(ipc)

  if (runtime) {
    installDesktopBrowserBridge({
      userDataPath: getAppEnvironment().getPath('userData'),
      runtime,
      getMainWindow,
      getConnectionManager: () => connectionManager
    })
  }

  return {
    ...registration,
    refresh: (getMainWindow: () => BrowserWindow | null, runtime?: OrcaRuntimeService) => {
      const refreshed = initializeSshSubsystem(getMainWindow, runtime, registerCompatibility)
      registration.handlers.clear()
      registration.listeners.clear()
      for (const [channel, handler] of refreshed.handlers) {
        registration.handlers.set(channel, handler)
      }
      for (const [channel, listener] of refreshed.listeners) {
        registration.listeners.set(channel, listener)
      }
    }
  }
}

export async function resetSshHandlerStateForTests(): Promise<void> {
  unregisterPowerMonitorReconnect()

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

  disposeDesktopBrowserBridge()
  await connectionManager?.disconnectAll()
  disposeOrcadManagedTunnels()
  portForwardManager?.dispose()
  setConnectionManager(null)
  setSshConnectionManagerResolver(null)
  setPortForwardManager(null)
  setSshTargetRegistryStore(null)
  setPersistedStore(null)
  setSshTargetRegistryHandlers({ connect: null, getState: null })
  setCurrentGetMainWindow(() => null)
  setCurrentRuntime(undefined)
}
