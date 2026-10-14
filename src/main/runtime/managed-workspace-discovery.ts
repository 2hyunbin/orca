import { resolveEnvironment, markEnvironmentUsed } from '../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import { ManagedRuntimeGatewayDescriptorSchema } from '../../shared/managed-runtime-gateway-contract'
import type { ManagedWorkspaceDiscoverySelector } from '../../shared/managed-workspace-discovery-contract'
import { MANAGED_RUNTIME_SESSION_CAPABILITY } from '../../shared/managed-runtime-session-contract'
import { verifyRemotePairingRuntimeStatus } from '../../shared/remote-pairing-verification'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { runtimeEnvironmentSshAccessBinding } from '../../shared/runtime-environment-authority-binding'
import { prepareRuntimeEnvironmentConnectionLease } from '../ipc/runtime-environment-connection-lease'
import { advanceRuntimeEnvironmentTransportGeneration } from '../ipc/runtime-environment-transport-generation'
import { admitEnvironmentProviderSshTarget } from '../ssh/environment-provider-ssh-admission'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { runtimeGatewayHostKeyFingerprint } from '../../shared/runtime-environment-gateway-overlay'

/** Verify the saved child pairing before exposing a credential-free workspace connection. */
export async function discoverManagedWorkspace(
  userDataPath: string,
  selector: ManagedWorkspaceDiscoverySelector,
  controllerRuntimeId: string
) {
  const target = getSshTargetRegistryStore()?.getTarget(selector.sshTargetId)
  const id = target?.orcadFence?.environmentId
  if (!target || !id || target.generation !== selector.targetGeneration) {
    throw new Error('The saved managed SSH target changed')
  }
  const environment = resolveEnvironment(userDataPath, id)
  assertRuntimeEnvironmentNotReconciling(environment)
  const deployment = environment.orcadDeployment
  if (
    !deployment ||
    deployment.sshTargetId !== target.id ||
    deployment.sshTargetGeneration !== selector.targetGeneration
  ) {
    throw new Error('The SSH target does not own that managed server')
  }
  const fingerprint = JSON.stringify(target)
  const binding = JSON.stringify(runtimeEnvironmentSshAccessBinding(environment))
  const provider = await admitEnvironmentProviderSshTarget(target)
  const current = (): boolean => {
    try {
      const saved = resolveEnvironment(userDataPath, id)
      return (
        !saved.reconciliation &&
        JSON.stringify(saved.orcadDeployment) === JSON.stringify(deployment) &&
        JSON.stringify(runtimeEnvironmentSshAccessBinding(saved)) === binding &&
        JSON.stringify(getSshTargetRegistryStore()?.getTarget(target.id)) === fingerprint &&
        (!provider || (!provider.signal.aborted && provider.isCurrent()))
      )
    } catch {
      return false
    }
  }
  if (!current()) {
    throw new Error('Managed workspace ownership changed')
  }
  const lease = await prepareRuntimeEnvironmentConnectionLease(
    userDataPath,
    {
      environmentId: id,
      pairingRevision: environment.pairingRevision ?? environment.createdAt
    },
    () => {},
    provider?.signal
  )
  try {
    if (!current() || !lease.isCurrent()) {
      throw new Error('Managed workspace pairing changed')
    }
    const reply = await sendRemoteRuntimeRequest<unknown>(lease.pairing, 'status.get', {}, 5000)
    if (!reply.ok) {
      throw new Error('The managed server is unavailable')
    }
    const verified = verifyRemotePairingRuntimeStatus(reply.result)
    if (
      !verified.ok ||
      verified.runtimeStatus.runtimeId !== reply._meta?.runtimeId ||
      !verified.runtimeStatus.capabilities?.includes(MANAGED_RUNTIME_SESSION_CAPABILITY)
    ) {
      throw new Error('The managed server needs an update or returned an invalid identity')
    }
    if (!current() || !lease.isCurrent()) {
      throw new Error('Managed workspace authority changed')
    }
    const runtimeId = verified.runtimeStatus.runtimeId
    const descriptor = ManagedRuntimeGatewayDescriptorSchema.parse({
      version: 1,
      controllerRuntimeId,
      environmentId: id,
      runtimeId,
      childHostKeyFingerprint: runtimeGatewayHostKeyFingerprint(lease.pairing.hostPublicKeyB64),
      sshTargetId: target.id,
      targetGeneration: selector.targetGeneration,
      name: environment.name
    })
    markEnvironmentUsed(userDataPath, id, {
      runtimeId,
      pairingDeviceToken: getPreferredPairedRuntimeConnection(environment).credential.deviceToken
    })
    if (resolveEnvironment(userDataPath, id).runtimeId !== runtimeId) {
      throw new Error('The verified managed identity could not be saved')
    }
    if (environment.runtimeId !== runtimeId) {
      advanceRuntimeEnvironmentTransportGeneration(id)
    }
    return descriptor
  } finally {
    lease.close()
  }
}
