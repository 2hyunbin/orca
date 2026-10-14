import { createHash } from 'node:crypto'
import type { KnownRuntimeEnvironment } from './runtime-environments'
import { getPreferredPairedRuntimeConnection } from './runtime-environments'
import { managedRuntimeGatewayPath } from './managed-runtime-gateway-contract'
import { managedWorkspaceGatewayCredential } from './managed-workspace-gateway-credential'

export function runtimeGatewayHostKeyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Resolve credentials in memory from the controller; a saved child contains only an inert reference. */
export function overlayRuntimeEnvironmentGateways(
  environments: KnownRuntimeEnvironment[]
): KnownRuntimeEnvironment[] {
  const byId = new Map(environments.map((environment) => [environment.id, environment]))
  return environments.map((environment) => {
    if (environment.kind !== 'managed-gateway' || !environment.managedGateway) {
      return environment
    }
    const link = environment.managedGateway
    const controller = byId.get(link.controllerEnvironmentId)
    if (
      !controller ||
      controller.kind === 'managed-gateway' ||
      (controller.pairingRevision ?? controller.createdAt) !== link.controllerPairingRevision
    ) {
      return { ...environment, gatewayConnectionBlocked: true }
    }
    const connection = getPreferredPairedRuntimeConnection(controller)
    if (
      runtimeGatewayHostKeyFingerprint(connection.hostPublicKeyB64) !==
      link.controllerHostKeyFingerprint
    ) {
      return { ...environment, gatewayConnectionBlocked: true }
    }
    try {
      const endpoint = new URL(connection.endpoint)
      if (
        !['ws:', 'wss:'].includes(endpoint.protocol) ||
        endpoint.pathname !== '/' ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.username ||
        endpoint.password
      ) {
        return { ...environment, gatewayConnectionBlocked: true }
      }
      endpoint.pathname = managedRuntimeGatewayPath(
        link.descriptor.environmentId,
        link.descriptor.targetGeneration
      )
      return {
        ...environment,
        pairedDeviceId: controller.pairedDeviceId,
        gatewayConnectionBlocked: false,
        endpoints: environment.endpoints.map((candidate) =>
          candidate.id === environment.preferredEndpointId
            ? {
                ...candidate,
                endpoint: endpoint.href,
                publicKeyB64: connection.hostPublicKeyB64,
                deviceToken: managedWorkspaceGatewayCredential(
                  connection.credential.deviceToken,
                  link.descriptor.environmentId,
                  link.descriptor.targetGeneration
                )
              }
            : candidate
        )
      }
    } catch {
      return { ...environment, gatewayConnectionBlocked: true }
    }
  })
}
