/** The production WSL side of `WslHostService`: one holder, connection manager and supervisor. */
import { readConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { parsePairingCode } from '../../shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { verifyOrcadPairingIdentity } from '../ssh/orcad-managed-tunnel-identity'
import { createWslDistroHolder, type WslDistroHolder } from './wsl-distro-holder'
import { listWslHostDistros } from './wsl-host-distro-list'
import type { WslHostConnector } from './wsl-host-service'
import { readWslDistroOrcadPublicKey } from './wsl-host-ssh-orcad-conflict'
import {
  WslOrcadConnectionManager,
  type WslOrcadConnectionDependencies
} from './wsl-orcad-connection'
import { defaultWslOrcadEnvironmentId, deployAndLaunchWslOrcad } from './wsl-orcad-deploy'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import {
  decommissionWslHostOrcad,
  stopWslHostServer,
  wslHostRuntimeStopSteps,
  type WslHostRuntimeAccess
} from './wsl-host-server-stop'
import { createWslOrcadLivenessSupervisor } from './wsl-orcad-liveness-wiring'
import type { WslOrcadLivenessSupervisor } from './wsl-orcad-liveness-supervisor'
import { confirmsRunning } from './wsl-orcad-liveness-model'
import { wslDistroHolderKey } from './wsl-distro-holder-record'

function targetFor(distro: string): WslOrcadHostTarget {
  return { kind: 'wsl', id: defaultWslOrcadEnvironmentId(distro), distro, label: distro }
}

function transportFor(distro: string) {
  return createWslOrcadHostTransport({ target: targetFor(distro) })
}

export function createWslHostConnector(options: {
  userDataPath: string
  onChange: NonNullable<WslOrcadConnectionDependencies['onChange']>
  hasUserVisibleWork: (distro: string) => boolean
  /** False once a distro's host is gone: nothing may be spawned for it again. */
  isKnownDistro: (distro: string) => boolean
  runtime: WslHostRuntimeAccess
}): WslHostConnector {
  const refuseUnknown = (distro: string): Error =>
    new Error(`${distro} is no longer a WSL host; Orca will not start anything for it.`)
  // Assigned below; a holder exit cannot arrive before the first ensure.
  let supervisor: WslOrcadLivenessSupervisor | null = null
  const unguardedHolder = createWslDistroHolder({
    userDataPath: options.userDataPath,
    onHolderExit: (distro, exit) => supervisor?.noteHolderExit(distro, exit)
  })
  // Why guard here: liveness recovery and deploy both reach these without the service.
  const holder: WslDistroHolder = {
    ...unguardedHolder,
    ensureHeld: (distro) =>
      options.isKnownDistro(distro)
        ? unguardedHolder.ensureHeld(distro)
        : Promise.reject(refuseUnknown(distro))
  }
  const manager = new WslOrcadConnectionManager({
    holder,
    onChange: options.onChange,
    deployAndLaunch: (distro, deployOptions) =>
      options.isKnownDistro(distro)
        ? deployAndLaunchWslOrcad(distro, deployOptions)
        : Promise.reject(refuseUnknown(distro))
  })
  const liveness = createWslOrcadLivenessSupervisor({
    manager,
    holder,
    hasUserVisibleWork: options.hasUserVisibleWork
  })
  supervisor = liveness
  const isReachable = async (distro: string): Promise<boolean> => {
    const connection = manager.get(distro)
    if (!connection) {
      return false
    }
    // Dialing the bridge starts wsl.exe, so passive checks must first confirm the distro runs.
    if (!confirmsRunning(await readConfirmedRunningWslDistros(), wslDistroHolderKey(distro))) {
      return false
    }
    const offer = parsePairingCode(connection.pairingOffer)
    if (!offer) {
      return false
    }
    const identity = await verifyOrcadPairingIdentity(pairedRuntimeConnectionFromOffer(offer), {
      runtimeId: null
    })
    return identity.verdict === 'verified' && manager.get(distro) === connection
  }
  return {
    listDistros: () => listWslHostDistros(),
    readOrcadPublicKey: (distro) => readWslDistroOrcadPublicKey(transportFor(distro)),
    connect: (distro, connectOptions) => liveness.connect(distro, connectOptions),
    get: (distro) => manager.get(distro),
    isReachable,
    disconnect: (distro) => liveness.stop(distro),
    stopServer: async (distro, environmentId) => {
      // A retained bridge is not proof that its distro or server still runs.
      const running = await readConfirmedRunningWslDistros()
      if (running.status === 'unavailable') {
        return { stopped: false, reason: 'The WSL service did not confirm whether the distro runs.' }
      }
      if (!confirmsRunning(running, wslDistroHolderKey(distro))) {
        return { stopped: true }
      }
      if (!(await isReachable(distro))) {
        await liveness.connect(distro)
      }
      const target = targetFor(distro)
      return stopWslHostServer({
        ...wslHostRuntimeStopSteps(options.runtime, environmentId),
        closeBridge: () => liveness.stop(distro),
        decommission: decommissionWslHostOrcad(target, createWslOrcadHostTransport({ target }))
      })
    },
    releaseHolder: async (distro) => {
      await holder.release(distro)
    },
    adoptHolders: async () => {
      await holder.adoptHolders()
    },
    dispose: () => liveness.dispose()
  }
}
