import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import { prepareRuntimeEnvironmentConnectionLease } from '../ipc/runtime-environment-connection-lease'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { admitEnvironmentProviderSshTarget } from '../ssh/environment-provider-ssh-admission'
import type { ManagedWorkspaceHosts } from './managed-workspace-gateway-contract'

/** Saved managed ownership and current provider approval decide access; caller endpoints are ignored. */
export function createManagedWorkspaceHosts(userDataPath: string): ManagedWorkspaceHosts {
  const listeners = new Set<(environmentId: string) => void>()
  const retire = (environmentId: string): void => {
    for (const listener of listeners) {
      listener(environmentId)
    }
  }
  return {
    onRetired(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async resolve(route) {
      const environment = resolveEnvironment(userDataPath, route.environmentId)
      assertRuntimeEnvironmentNotReconciling(environment)
      const deployment = environment.orcadDeployment
      const target = deployment
        ? getSshTargetRegistryStore()?.getTarget(deployment.sshTargetId)
        : null
      if (
        !deployment ||
        !target ||
        !environment.runtimeId ||
        deployment.sshTargetGeneration !== route.targetGeneration ||
        target.generation !== route.targetGeneration ||
        target.orcadFence?.environmentId !== environment.id
      ) {
        throw new Error('Managed workspace identity or target generation is unavailable')
      }
      const provider = await admitEnvironmentProviderSshTarget(target)
      const changed = (): void => retire(environment.id)
      provider?.signal.addEventListener('abort', changed, { once: true })
      const fingerprint = JSON.stringify(target)
      const current = (): boolean => {
        try {
          const saved = resolveEnvironment(userDataPath, environment.id)
          return (
            !saved.reconciliation &&
            JSON.stringify(saved.orcadDeployment) === JSON.stringify(deployment) &&
            JSON.stringify(getSshTargetRegistryStore()?.getTarget(target.id)) === fingerprint &&
            (!provider || (!provider.signal.aborted && provider.isCurrent()))
          )
        } catch {
          return false
        }
      }
      let close: (() => void) | undefined
      try {
        if (!current()) {
          throw new Error('Managed workspace approval changed')
        }
        const connection = await prepareRuntimeEnvironmentConnectionLease(
          userDataPath,
          {
            environmentId: environment.id,
            pairingRevision: environment.pairingRevision ?? environment.createdAt,
            runtimeId: environment.runtimeId
          },
          changed,
          provider?.signal
        )
        close = connection.close
        if (!current() || !connection.isCurrent()) {
          throw new Error('Managed workspace connection changed')
        }
        return {
          connection: connection.pairing,
          runtimeId: environment.runtimeId,
          isCurrent: () => current() && connection.isCurrent(),
          close: () => {
            connection.close()
            provider?.signal.removeEventListener('abort', changed)
          }
        }
      } catch (error) {
        close?.()
        provider?.signal.removeEventListener('abort', changed)
        throw error
      }
    }
  }
}
