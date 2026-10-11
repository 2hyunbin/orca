import { randomUUID } from 'node:crypto'
import type { DeviceEntry } from './device-registry'
import { devicePrincipalOf } from './device-principal'

const MAX_FORKS_PER_TOKEN_ROW = 32

export class DeviceKeyForkError extends Error {
  constructor(
    readonly code:
      | 'device_not_found'
      | 'device_already_keyed'
      | 'delegated_device'
      | 'device_key_in_use'
      | 'too_many_device_keys'
  ) {
    super(code)
  }
}

export type DeviceKeyFork = { nextDevices: DeviceEntry[]; entry: DeviceEntry; created: boolean }

/**
 * Forks a token row into a keyed row for one installation. The token row stays, so every other
 * holder of the same token (other tabs, machines, env-var users) and its live sockets keep working.
 * Idempotent per (token row, key): a lost reply retried with the same key returns the same row.
 */
export function planDeviceKeyFork(
  devices: readonly DeviceEntry[],
  legacyDeviceId: string,
  devicePublicKeyB64: string,
  label: string,
  now: number,
  options: { ephemeral?: boolean } = {}
): DeviceKeyFork {
  const legacy = devices.find((device) => device.deviceId === legacyDeviceId)
  if (!legacy) {
    throw new DeviceKeyForkError('device_not_found')
  }
  if (legacy.credentialKind === 'device-key' || legacy.token === undefined) {
    throw new DeviceKeyForkError('device_already_keyed')
  }
  // Why: a relayed child authenticates through its parent desktop, which owns its credential.
  if (legacy.parentDeviceId !== undefined) {
    throw new DeviceKeyForkError('delegated_device')
  }
  const sameKey = devices.filter((device) => device.devicePublicKeyB64 === devicePublicKeyB64)
  const existing = sameKey.find((device) => device.forkedFrom === legacyDeviceId)
  if (existing) {
    return { nextDevices: [...devices], entry: existing, created: false }
  }
  // Why: one key is one installation; reusing it under another row would merge two identities.
  if (sameKey.length > 0) {
    throw new DeviceKeyForkError('device_key_in_use')
  }
  // Why: bounds registry growth from one shared code; real installations are a handful.
  if (
    devices.filter((device) => device.forkedFrom === legacyDeviceId).length >=
    MAX_FORKS_PER_TOKEN_ROW
  ) {
    throw new DeviceKeyForkError('too_many_device_keys')
  }
  const entry: DeviceEntry = {
    deviceId: randomUUID(),
    name: label,
    scope: legacy.scope,
    ...(legacy.grants ? { grants: [...legacy.grants] } : {}),
    pairingReach: legacy.pairingReach,
    ...(legacy.mobilePairingConnectionMode
      ? { mobilePairingConnectionMode: legacy.mobilePairingConnectionMode }
      : {}),
    credentialKind: 'device-key',
    devicePublicKeyB64,
    forkedFrom: legacy.deviceId,
    ...(options.ephemeral ? { ephemeral: true as const } : {}),
    // Why: orchestration work owned under the token keeps its owner after migration.
    callerFingerprint: devicePrincipalOf(legacy).callerFingerprint,
    pairedAt: now,
    // Why: lastSeenAt 0 marks a never-scanned pending row, which rotation deletes.
    lastSeenAt: now
  }
  return { nextDevices: [...devices, entry], entry, created: true }
}

export type RedeemedDeviceKey = {
  deviceId: string
  label: string
  scope: DeviceEntry['scope']
  grants: NonNullable<DeviceEntry['grants']>
  pairingReach: NonNullable<DeviceEntry['pairingReach']>
  devicePublicKeyB64: string
}

/** A keyed row for a redeemed ticket; authority comes from the ticket, never from the client (I6). */
export function planRedeemedDeviceKey(
  devices: readonly DeviceEntry[],
  redeemed: RedeemedDeviceKey,
  now: number
): { nextDevices: DeviceEntry[]; entry: DeviceEntry } {
  // Why: one key is one installation, and a reserved id must never land on an existing row.
  if (
    devices.some(
      (device) =>
        device.devicePublicKeyB64 === redeemed.devicePublicKeyB64 ||
        device.deviceId === redeemed.deviceId
    )
  ) {
    throw new DeviceKeyForkError('device_key_in_use')
  }
  const entry: DeviceEntry = {
    deviceId: redeemed.deviceId,
    name: redeemed.label,
    scope: redeemed.scope,
    ...(redeemed.grants.length > 0 ? { grants: [...redeemed.grants] } : {}),
    pairingReach: redeemed.pairingReach,
    credentialKind: 'device-key',
    devicePublicKeyB64: redeemed.devicePublicKeyB64,
    pairedAt: now,
    lastSeenAt: now
  }
  return { nextDevices: [...devices, entry], entry }
}
