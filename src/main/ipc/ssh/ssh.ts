import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../../persistence'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { SshConnectionStore } from '../../ssh/connection/ssh-connection-store'
import { holdLaunchReconnectOptOuts, resetLaunchReconnectOptOutsForTests } from './ssh-host-user-disconnect'
import {
  connectRegisteredSshTarget,
  getSshTargetRegistryStore,
  setSshConnectionManagerInitializer,
  setSshConnectionManagerResolver,
  setSshTargetMutations,
  setSshTargetRegistryHandlers,
  setSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import { initializeSshConnectionGenerationSession } from '../../ssh/connection/ssh-connection-generation'
import { isSshCredentialDeclined } from '../../ssh/ssh-credential-decline'
import { awaitSignInForCredentialHosts } from './ssh-sign-in-requirement'
import { registerSshTargetCrudHandlers } from './ssh-target-crud-handlers'
import { registerCredentialHandler } from './ssh-passphrase'
import { getPublicSshState } from './ssh-renderer-broadcast'
import { listUnrestoredPortForwards } from './ssh-port-forward-unrestored'
import { LEGACY_RELAY_BRIDGE_CHANNELS } from '../../../shared/legacy-relay-bridge-contract'
import { PLAIN_SSH_TERMINAL_CHANNELS } from '../../../shared/plain-ssh-terminal'
import { quitTeardownStartGate } from '../../quit-teardown-start-gate'
import { createSshSubsystemLoader } from './ssh-subsystem-loader'
import type * as SshImplementation from './ssh-implementation'
import type * as SshTransport from './ssh-transport'
import {
  connectionManager,
  currentRuntime,
  getCurrentMainWindow,
  setCurrentGetMainWindow,
  setCurrentRuntime,
  setPersistedStore
} from './ssh-ipc-context'

const SSH_LAZY_CHANNELS = [
  'ssh:connect',
  'ssh:disconnect',
  'ssh:getState',
  'ssh:needsPassphrasePrompt',
  'ssh:testConnection',
  'ssh:browseDir',
  'ssh:addPortForward',
  'ssh:updatePortForward',
  'ssh:removePortForward',
  'ssh:listPortForwards',
  'ssh:listUnrestoredPortForwards',
  'ssh:removeSavedPortForward',
  'ssh:listDetectedPorts',
  PLAIN_SSH_TERMINAL_CHANNELS.open,
  LEGACY_RELAY_BRIDGE_CHANNELS.listPanes,
  LEGACY_RELAY_BRIDGE_CHANNELS.attach,
  LEGACY_RELAY_BRIDGE_CHANNELS.close
] as const
const SSH_EVENT_CHANNELS = [
  PLAIN_SSH_TERMINAL_CHANNELS.write,
  PLAIN_SSH_TERMINAL_CHANNELS.resize,
  PLAIN_SSH_TERMINAL_CHANNELS.close,
  PLAIN_SSH_TERMINAL_CHANNELS.ack,
  LEGACY_RELAY_BRIDGE_CHANNELS.write,
  LEGACY_RELAY_BRIDGE_CHANNELS.resize,
  LEGACY_RELAY_BRIDGE_CHANNELS.detach,
  LEGACY_RELAY_BRIDGE_CHANNELS.setOutputPaused
] as const

let registration: { store: Store; runtime?: OrcaRuntimeService } | undefined
let transport = createTransport()
let subsystem = createSubsystem()
let startupReady: Promise<void> | undefined
let initializedTransport: typeof SshTransport | undefined
let initializedModule: typeof SshImplementation | undefined

function createTransport() {
  const loader = createSshSubsystemLoader(
    () => import('./ssh-transport'),
    (implementation) => {
      if (!registration || transport !== loader) {
        throw new Error('SSH registration was replaced')
      }
      initializedTransport = implementation
      return implementation.initializeSshTransport()
    }
  )
  return loader
}

function createSubsystem() {
  const loader = createSshSubsystemLoader(
    // COMPAT(legacy-relay-bridge): install the existing compatibility handlers only on first use.
    () =>
      Promise.all([
        import('./ssh-implementation'),
        import('../../ssh/legacy-relay/legacy-relay-bridge-ipc'),
        transport.load()
      ]),
    ([implementation, compatibility]) => {
      if (!registration || subsystem !== loader) {
        throw new Error('SSH registration was replaced')
      }
      initializedModule = implementation
      implementation.initializeSshMigrationState(registration.store)
      return implementation.initializeSshSubsystem(
        getCurrentMainWindow,
        registration.runtime,
        (ipc) =>
          compatibility.registerLegacyRelayBridgeIpc(
            {
              store: registration!.store,
              getMainWindow: getCurrentMainWindow,
              connection: (targetId) => connectionManager?.getConnection(targetId) ?? null,
              runtime: () => currentRuntime ?? null
            },
            ipc
          )
      )
    }
  )
  return loader
}

export function ensureSshHandlersLoaded(): Promise<void> {
  return subsystem.load().then(() => undefined)
}

export function whenSshStartupReady(): Promise<void> | undefined {
  return startupReady
}

export function registerSshHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null,
  runtime?: OrcaRuntimeService
) {
  initializeSshConnectionGenerationSession()
  registration = { store, runtime }
  setCurrentGetMainWindow(getMainWindow)
  setCurrentRuntime(runtime)
  setPersistedStore(store)
  const sshStore = new SshConnectionStore(store)
  setSshTargetRegistryStore(sshStore)
  if (!connectionManager) {
    awaitSignInForCredentialHosts(sshStore)
    holdLaunchReconnectOptOuts(sshStore.listTargets())
  }
  setSshConnectionManagerResolver(() => connectionManager)
  setSshConnectionManagerInitializer(ensureSshHandlersLoaded)
  if (!subsystem.loaded) {
    setSshTargetRegistryHandlers({
      connect: async (targetId, options) => {
        await ensureSshHandlersLoaded()
        return connectRegisteredSshTarget(targetId, options)
      },
      getState: (targetId) => (connectionManager ? getPublicSshState(targetId) : undefined)
    })
  }
  subsystem.loaded?.refresh(getCurrentMainWindow, runtime)
  registerCredentialHandler()
  for (const channel of [
    'ssh:listTargets',
    'ssh:listRemovedTargetLabels',
    'ssh:addTarget',
    'ssh:updateTarget',
    'ssh:removeTarget',
    'ssh:importConfig',
    'ssh:listConfigHosts',
    'ssh:resolveConfigHost'
  ]) {
    ipcMain.removeHandler(channel)
  }
  registerSshTargetCrudHandlers()
  for (const channel of SSH_LAZY_CHANNELS) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!subsystem.loaded) {
        if (channel === 'ssh:getState') {
          const input = args[0]
          return connectionManager &&
            typeof input === 'object' &&
            input !== null &&
            'targetId' in input &&
            typeof input.targetId === 'string'
            ? getPublicSshState(input.targetId)
            : undefined
        }
        if (
          channel === 'ssh:listPortForwards' ||
          channel === 'ssh:listDetectedPorts' ||
          channel === LEGACY_RELAY_BRIDGE_CHANNELS.listPanes
        ) {
          return []
        }
        if (channel === 'ssh:listUnrestoredPortForwards') {
          const input = args[0]
          return typeof input === 'object' &&
            input !== null &&
            'targetId' in input &&
            typeof input.targetId === 'string'
            ? listUnrestoredPortForwards(input.targetId)
            : []
        }
        if (channel === 'ssh:needsPassphrasePrompt') {
          const input = args[0]
          if (
            typeof input !== 'object' ||
            input === null ||
            !('targetId' in input) ||
            typeof input.targetId !== 'string'
          ) {
            return false
          }
          const target = sshStore.getTarget(input.targetId)
          return (
            isSshCredentialDeclined(input.targetId) ||
            (target?.lastRequiredPassphrase === true &&
              !connectionManager?.hasCachedCredential(target))
          )
        }
      }
      if (channel === 'ssh:testConnection') {
        const loaded = transport.loaded
        return loaded
          ? loaded.handlers.get(channel)!(event, ...args)
          : transport.load().then(({ handlers }) => handlers.get(channel)!(event, ...args))
      }
      const loaded = subsystem.loaded
      if (loaded) {
        return loaded.handlers.get(channel)!(event, ...args)
      }
      return subsystem.load().then(({ handlers }) => handlers.get(channel)!(event, ...args))
    })
  }
  for (const channel of SSH_EVENT_CHANNELS) {
    ipcMain.removeAllListeners(channel)
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      // Sessions can only emit input after their open/attach invocation loaded the subsystem.
      subsystem.loaded?.listeners.get(channel)?.(event, ...args)
    })
  }
  if (sshStore.listTargets().some((target) => target.orcadFence || target.orcadProvisioning)) {
    startupReady ??= ensureSshHandlersLoaded().catch((error: unknown) =>
      console.warn('[ssh] Could not restore saved managed hosts:', error)
    )
  }
  return {
    get connectionManager() {
      return connectionManager
    },
    sshStore
  }
}

export async function resetSshHandlerStateForTests(): Promise<void> {
  resetLaunchReconnectOptOutsForTests()
  await (initializedModule
    ? initializedModule.resetSshHandlerStateForTests()
    : initializedTransport?.resetSshTransportStateForTests())
  initializedTransport = undefined
  initializedModule = undefined
  registration = undefined
  startupReady = undefined
  transport = createTransport()
  subsystem = createSubsystem()
  setSshTargetMutations(null)
  setSshConnectionManagerInitializer(null)
  setSshConnectionManagerResolver(null)
  setSshTargetRegistryStore(null)
  setSshTargetRegistryHandlers({ connect: null, getState: null })
  quitTeardownStartGate.resetForTests()
}

export function getSshConnectionStore(): SshConnectionStore | null {
  return getSshTargetRegistryStore()
}
