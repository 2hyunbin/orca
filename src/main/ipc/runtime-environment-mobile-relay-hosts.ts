import { app } from 'electron'
import { pairedRuntimeBrowserClientHostsPage } from '../browser/paired-runtime-browser-client-host-runtime'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  getPreferredPairingOffer,
  isWslHostRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeEnvironmentStatus
} from '../../shared/runtime-host-status'
import type {
  MobileDesktopRelayHost,
  MobileDesktopRelayHosts
} from '../runtime/mobile-desktop-relay/mobile-desktop-relay-hosts'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import type { SshConnectionState } from '../../shared/ssh-types'
import { getRegisteredSshState, listRegisteredSshTargets } from '../ssh/ssh-target-registry'
import { getRuntimeEnvironmentStatusSnapshots } from './runtime-environment-request-connections'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { isGatedOffWslHost } from '../wsl/wsl-host-gate'
import { getWslHostService } from '../wsl/wsl-host-service-instance'
import { mobileRelayRequestsWork } from '../runtime/mobile-desktop-relay/mobile-relay-work-demand'

const retirementListeners = new Set<(environmentId: string) => void>()

/** Called wherever the desktop's own transport to a server is invalidated. */
export function retireMobileDesktopRelayEnvironment(environmentId: string): void {
  for (const listener of retirementListeners) {
    listener(environmentId)
  }
}

/** Configured hosts, behind the same availability gate as the desktop. Listing never connects. */
function listRelayableEnvironments(userDataPath: string) {
  return listEnvironments(userDataPath).filter((environment) => !isGatedOffWslHost(environment))
}

/** The desktop's configured servers, addressed only by exact environment id. */
export function createRuntimeEnvironmentMobileRelayHosts(): MobileDesktopRelayHosts {
  // Why userData: configured servers live where the runtime-environment handlers keep them.
  const userDataPath = app.getPath('userData')
  return {
    list: () => {
      const environments = listRelayableEnvironments(userDataPath)
      const statusByEnvironmentId = new Map<string, RuntimeEnvironmentStatus>()
      for (const snapshot of getRuntimeEnvironmentStatusSnapshots()) {
        const environment = environments.find((entry) => entry.id === snapshot.environmentId)
        // Why: as in the renderer, a snapshot from an earlier pairing says nothing about this one.
        if (environment && pairingRevision(environment) === snapshot.pairingRevision) {
          statusByEnvironmentId.set(environment.id, runtimeEnvironmentStatusFromSnapshot(snapshot))
        }
      }
      const sshTargets = listRegisteredSshTargets()
      const sshConnectionStates = new Map<string, SshConnectionState>()
      for (const target of sshTargets) {
        const state = getRegisteredSshState(target.id)
        if (state) {
          sshConnectionStates.set(target.id, state)
        }
      }
      return {
        sshTargetLabels: new Map(sshTargets.map((target) => [target.id, target.label])),
        sshConnectionStates,
        environments: environments.map((environment) => ({
          id: environment.id,
          name: environment.name,
          source: environment.source,
          orcadDeployment: environment.orcadDeployment,
          pairingRevision: pairingRevision(environment),
          runtimeId: environment.runtimeId,
          ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {})
        })),
        statusByEnvironmentId
      }
    },
    resolve: async (environmentId) => {
      if (!listRelayableEnvironments(userDataPath).some((entry) => entry.id === environmentId)) {
        return null
      }
      const environment = await resolveManagedRuntimeEnvironment(userDataPath, environmentId)
      return relayHost(environment)
    },
    captureRegistration: (environmentId) => {
      const environment = listRelayableEnvironments(userDataPath).find(
        (entry) => entry.id === environmentId
      )
      if (!environment) {
        return null
      }
      const createdAt = environment.createdAt
      const serverKey = getPreferredPairingOffer(environment).publicKeyB64
      return () => {
        const current = listRelayableEnvironments(userDataPath).find(
          (entry) => entry.id === environmentId
        )
        return current &&
          current.createdAt === createdAt &&
          getPreferredPairingOffer(current).publicKeyB64 === serverKey
          ? relayHost(current)
          : null
      }
    },
    acquireDemand: (environmentId, method) => {
      const environment = listRelayableEnvironments(userDataPath).find(
        (entry) => entry.id === environmentId
      )
      const service = getWslHostService()
      if (
        !environment ||
        !isWslHostRuntimeEnvironment(environment) ||
        !service ||
        !mobileRelayRequestsWork(method)
      ) {
        return null
      }
      const release = service.acquireDemand(environmentId)
      return {
        // Prepare before taking the pairing fence: reconnect can rotate the bridge's credentials.
        ready: Promise.resolve().then(() => service.ensureForRuntimeCall(environmentId)),
        release
      }
    },
    call: (host, method, params, options) =>
      callRuntimeEnvironment(
        userDataPath,
        host.environmentId,
        method,
        params,
        options?.timeoutMs,
        options?.expected?.pairingRevision,
        undefined,
        options?.expected?.runtimeId
          ? { expectedEnvironmentRuntimeId: options.expected.runtimeId }
          : undefined
      ),
    hostsBrowserPage: pairedRuntimeBrowserClientHostsPage,
    onEnvironmentRetired: (listener) => {
      retirementListeners.add(listener)
      return () => retirementListeners.delete(listener)
    }
  }
}

function pairingRevision(environment: KnownRuntimeEnvironment): number {
  return environment.pairingRevision ?? environment.createdAt
}

function relayHostFence(environment: KnownRuntimeEnvironment): string {
  return `${pairingRevision(environment)}\0${environment.runtimeId}`
}

function relayHost(environment: KnownRuntimeEnvironment): MobileDesktopRelayHost {
  return {
    environmentId: environment.id,
    fence: relayHostFence(environment),
    pairing: getPreferredPairingOffer(environment)
  }
}
