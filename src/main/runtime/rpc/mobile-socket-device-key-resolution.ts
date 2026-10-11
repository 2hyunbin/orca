import type { DeviceKeyLookup } from '../device-entry'
import type { DeviceRegistry } from '../device-registry'
import type { DeviceKeyResolution } from './mobile-e2ee-auth-validation'
import type { MobileSocketTransportMetadata } from './mobile-socket-wiring'

/** Which keyed row a socket may sign in as, without ever calling an existing device revoked. */
export function resolveSocketDeviceKey<TDevice>(args: {
  registry: Pick<DeviceRegistry, 'lookupDeviceKey'>
  deviceId: string
  metadata: MobileSocketTransportMetadata
  isReservedDeviceId: (deviceId: string) => boolean
  toDevice: (device: Extract<DeviceKeyLookup, { kind: 'found' }>['device']) => TDevice
}): DeviceKeyResolution<TDevice> {
  const lookup = args.registry.lookupDeviceKey(args.deviceId)
  // Why: a ticket's reserved id has no row until redemption commits; a client must keep its key.
  if (lookup.kind === 'unknown' && args.isReservedDeviceId(args.deviceId)) {
    return { kind: 'unavailable' }
  }
  if (lookup.kind !== 'found') {
    return lookup
  }
  // Why: same relay binding rule as token auth — the outer relay cannot pick the identity.
  // A fork keeps its token row's Relay binding (the key proof names the installation).
  // Never "unknown": the device exists, and that verdict would make the client delete its key.
  const { metadata } = args
  if (
    metadata.transport === 'relay' &&
    metadata.relayDeviceId !== lookup.device.deviceId &&
    metadata.relayDeviceId !== lookup.device.forkedFrom
  ) {
    return { kind: 'refused' }
  }
  return {
    kind: 'found',
    device: args.toDevice(lookup.device),
    devicePublicKeyB64: lookup.device.devicePublicKeyB64
  }
}
