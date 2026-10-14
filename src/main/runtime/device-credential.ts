import { randomBytes, randomUUID } from 'node:crypto'
import type { DeviceScope } from '../../shared/runtime-types'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { TokenDeviceEntry } from './device-entry'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'
import { validGrants } from './device-registry-row-validation'

/** A fresh device id and its bearer token; every registry entry is minted here. */
export function mintDeviceCredential(): { deviceId: string; token: string } {
  return { deviceId: randomUUID(), token: randomBytes(24).toString('hex') }
}

export function mintPairedDeviceEntry(
  name: string,
  scope: DeviceScope,
  pairingReach: RuntimePairingReach,
  grants: readonly RuntimeDeviceGrant[]
): TokenDeviceEntry {
  const validatedGrants = validGrants(grants, scope)
  return {
    ...mintDeviceCredential(),
    name,
    scope,
    pairedAt: Date.now(),
    lastSeenAt: 0,
    pairingReach,
    ...(validatedGrants ? { grants: validatedGrants } : {})
  }
}
