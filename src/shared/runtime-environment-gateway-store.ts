import { createHash } from 'node:crypto'
import type { ManagedRuntimeGatewayDescriptor } from './managed-runtime-gateway-contract'
import { ManagedRuntimeGatewayDescriptorSchema } from './managed-runtime-gateway-contract'
import { resolveEnvironment } from './runtime-environment-store'
import {
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import {
  KnownRuntimeEnvironmentSchema,
  getPreferredPairedRuntimeConnection
} from './runtime-environments'
import { runtimeGatewayHostKeyFingerprint } from './runtime-environment-gateway-overlay'
import { MANAGED_GATEWAY_INERT_TOKEN } from './runtime-environment-gateway-link'

/** Persist a controller reference, never a copied controller or child credential. */
export function saveManagedGatewayEnvironment(
  userDataPath: string,
  controllerEnvironmentId: string,
  descriptor: ManagedRuntimeGatewayDescriptor
) {
  const verified = ManagedRuntimeGatewayDescriptorSchema.parse(descriptor)
  if (!verified.childHostKeyFingerprint) {
    throw new Error('The controller needs an update to verify workspace identity')
  }
  const controller = resolveEnvironment(userDataPath, controllerEnvironmentId)
  if (
    controller.kind === 'managed-gateway' ||
    controller.runtimeId !== verified.controllerRuntimeId
  ) {
    throw new Error('The verified controller identity changed')
  }
  const pairing = getPreferredPairedRuntimeConnection(controller)
  const id = `managed-gateway-${createHash('sha256')
    .update(JSON.stringify([controllerEnvironmentId, verified.environmentId]))
    .digest('hex')
    .slice(0, 32)}`
  const store = readPersistedEnvironmentStore(userDataPath)
  const previous = store.environments.find((environment) => environment.id === id)
  if (previous && previous.kind !== 'managed-gateway') {
    throw new Error('Managed workspace registration conflicts with another server')
  }
  const now = Date.now()
  const endpoint = new URL(pairing.endpoint)
  if (
    !['ws:', 'wss:'].includes(endpoint.protocol) ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error('This controller connection does not support workspace access')
  }
  // An inert endpoint keeps older record parsers harmless even if the kind marker is stripped.
  endpoint.pathname = `/_orca/managed/${encodeURIComponent(verified.environmentId)}/${String(verified.targetGeneration)}`
  const environment = KnownRuntimeEnvironmentSchema.parse({
    id,
    kind: 'managed-gateway',
    name: previous?.name ?? `${verified.name} · ${controller.name}`,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    pairingRevision: Math.max(now, (previous?.pairingRevision ?? 0) + 1),
    lastUsedAt: previous?.lastUsedAt ?? null,
    runtimeId: verified.runtimeId,
    preferredEndpointId: 'gateway',
    endpoints: [
      {
        id: 'gateway',
        kind: 'websocket',
        label: 'Through control host',
        endpoint: endpoint.href,
        deviceToken: MANAGED_GATEWAY_INERT_TOKEN,
        publicKeyB64: pairing.hostPublicKeyB64
      }
    ],
    managedGateway: {
      controllerEnvironmentId,
      controllerPairingRevision: controller.pairingRevision ?? controller.createdAt,
      controllerHostKeyFingerprint: runtimeGatewayHostKeyFingerprint(pairing.hostPublicKeyB64),
      descriptor: verified
    }
  })
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: [...store.environments.filter((entry) => entry.id !== id), environment]
  })
  return resolveEnvironment(userDataPath, id)
}
