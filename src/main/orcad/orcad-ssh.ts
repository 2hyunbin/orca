import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { SshConnectionManager } from '../ssh/ssh-connection-manager'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import {
  getSshTargetRegistryStore,
  setSshTargetRegistryStore,
  setSshTargetRegistryHandlers,
  setSshTargetMutations,
  setSshConnectionManagerResolver
} from '../ssh/ssh-target-registry'
import { createSshTargetMutations } from '../ssh/ssh-target-mutations'
import { removeSshTargetRegistration } from '../ssh/ssh-target-transport'
import { handleSshConnectionStateChange } from '../ssh/ssh-connection-state-publisher'
import { initializeSshConnectionGenerationSession } from '../ssh/ssh-connection-generation'
import { reconcileManagedOrcadSshTargets } from '../ssh/orcad-retained-source'
import { installOrcadMigrationScrollbackRetention } from '../ssh/orcad-migration-scrollback-retention-wiring'
import { setOrcadMigrationJournalChangeListener } from '../ssh/orcad-migration-cutover-journal'
import { disposeOrcadManagedTunnels, closeOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { setManagedOrcadStartListener } from '../ssh/orcad-managed-serving'
import { connectTarget } from '../ipc/ssh-connect-flow'
import { getPublicSshState, clearPublishedManagedServer } from '../ipc/ssh-renderer-broadcast'
import {
  installManagedOrcadStartStatus,
  clearManagedServerNotes
} from '../ipc/runtime-environment-managed-tunnel'
import { persistPortForwardsWithUnrestored } from '../ipc/ssh-port-forward-persistence'
import {
  setConnectionManager,
  setPortForwardManager,
  setPersistedStore,
  setCurrentRuntime
} from '../ipc/ssh-ipc-context'
import { beginSshShutdown } from '../ipc/ssh-shutdown-drain'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import { createManagedOrcadActions } from '../ssh/managed-orcad-actions'
import { registerManagedServerActions } from '../runtime/managed-server-actions-registry'
import { trackManagedServerActions } from '../runtime/managed-server-action-lifetime'
import { retireRuntimeEnvironmentState } from '../runtime/runtime-environment-retirement'
import { advanceRuntimeEnvironmentTransportGeneration } from '../ipc/runtime-environment-transport-generation'
import { advanceRuntimeEnvironmentCapabilityIncarnation } from '../ipc/runtime-environment-capability-evidence'

export function startOrcadSsh(options: {
  store: Store
  runtime: OrcaRuntimeService
  userDataPath: string
  registerCleanup(cleanup: OrcadRuntimeCleanup): void
}): { sshStore: SshConnectionStore; connectionManager: SshConnectionManager } {
  if (getSshTargetRegistryStore() || quitTeardownStartGate.hasStarted()) {
    throw new Error('SSH host ownership is already registered or stopping')
  }
  const { store, runtime, userDataPath } = options
  initializeSshConnectionGenerationSession()
  const sshStore = new SshConnectionStore(store)
  // Headless hosts use their SSH configuration and agent; credentials never cross paired RPC.
  const manager = new SshConnectionManager({ onStateChange: handleSshConnectionStateChange })
  const forwards = new SshPortForwardManager()
  let stopped = false
  setPersistedStore(store)
  setCurrentRuntime(runtime)
  setConnectionManager(manager)
  setPortForwardManager(forwards)
  setSshTargetRegistryStore(sshStore)
  setSshConnectionManagerResolver(() => manager)
  setSshTargetRegistryHandlers({ connect: connectTarget, getState: getPublicSshState })
  setSshTargetMutations(
    createSshTargetMutations({
      notifyReposChanged: () => runtime.notifyReposChangedForRemoteClients(),
      removeTarget: (targetId) => removeSshTargetRegistration(targetId)
    })
  )
  const invalidateTransport = (environmentId: string): Promise<void> => {
    advanceRuntimeEnvironmentCapabilityIncarnation(environmentId)
    advanceRuntimeEnvironmentTransportGeneration(environmentId)
    return closeOrcadManagedTunnel(environmentId)
  }
  const managed = trackManagedServerActions(
    createManagedOrcadActions({
      getUserDataPath: () => userDataPath,
      getActiveEnvironmentId: () => null,
      invalidateTransport,
      clearHostServerStatus: clearPublishedManagedServer,
      clearHostServerNotes: clearManagedServerNotes,
      store,
      retireLocalState: (environmentId) =>
        retireRuntimeEnvironmentState(environmentId, invalidateTransport, store)
    })
  )
  registerManagedServerActions(managed.actions)
  forwards.setCallbacks({
    onForwardClosed: (entry, reason) => {
      if (!stopped) {
        persistPortForwardsWithUnrestored(entry.connectionId)
        if (reason.kind === 'unexpected-exit') {
          console.warn(`[ssh] Port forward ${entry.localPort} closed unexpectedly`)
        }
      }
    }
  })
  options.registerCleanup(async () => {
    stopped = true
    registerManagedServerActions(null)
    await managed.drain()
    quitTeardownStartGate.start()
    const targetIds = new Set([
      ...sshStore.listTargets().map((target) => target.id),
      ...manager.getAllStates().keys()
    ])
    const result = await beginSshShutdown()
    await Promise.all([...targetIds].map((id) => forwards.removeAllForwards(id)))
    disposeOrcadManagedTunnels()
    forwards.dispose()
    if (result.unfinished.length || result.errors.length) {
      throw new AggregateError(result.errors, 'SSH host shutdown did not finish')
    }
    setManagedOrcadStartListener(null)
    setOrcadMigrationJournalChangeListener(null)
    setSshTargetRegistryHandlers({ connect: null, getState: null })
    setSshTargetMutations(null)
    setSshConnectionManagerResolver(null)
    setSshTargetRegistryStore(null)
    setConnectionManager(null)
    setPortForwardManager(null)
    setCurrentRuntime(undefined)
    setPersistedStore(null)
  })
  reconcileManagedOrcadSshTargets(userDataPath, store)
  installOrcadMigrationScrollbackRetention(userDataPath, store)
  installManagedOrcadStartStatus()
  return { sshStore, connectionManager: manager }
}
