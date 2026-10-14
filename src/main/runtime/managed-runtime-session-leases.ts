import { createHash } from 'node:crypto'
import { MANAGED_RUNTIME_SESSION_LIFETIME_MS } from '../../shared/managed-runtime-session-contract'
import type { ManagedRuntimeSessionGrant } from '../../shared/managed-runtime-session-contract'
import { mintDeviceCredential } from './device-credential'
import { isStillAuthenticated, sameGrants, type DeviceEntry } from './device-entry'
import { devicePrincipalOf } from './device-principal'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'

const MAX_SESSIONS = 128
const MAX_PARENT_SESSIONS = 32

type Lease = {
  device: DeviceEntry & { token: string }
  parent: DeviceEntry
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

/** Private, expiring child credentials; never written to the durable device registry. */
export class ManagedRuntimeSessionLeases {
  private readonly leases = new Map<string, Lease>()
  private readonly retirementListeners = new Set<(deviceId: string) => void>()

  constructor(private readonly resolveParent: (deviceId: string) => DeviceEntry | null) {}

  open(
    parentDeviceId: string,
    subjectKey: string,
    name: string,
    grants: readonly RuntimeDeviceGrant[] = []
  ): ManagedRuntimeSessionGrant {
    const parent = this.resolveParent(parentDeviceId)
    if (parent?.scope !== 'runtime' || parent.runtimeLease) {
      throw new Error('managed_session_parent_unavailable')
    }
    if (grants.some((grant) => !parent.grants?.includes(grant))) {
      throw new Error('managed_session_grant_refused')
    }
    this.prune()
    if (
      this.leases.size >= MAX_SESSIONS ||
      [...this.leases.values()].filter((lease) => lease.parent.deviceId === parentDeviceId)
        .length >= MAX_PARENT_SESSIONS
    ) {
      throw new Error('managed_session_capacity_reached')
    }
    const now = Date.now()
    const device = {
      ...mintDeviceCredential(),
      name,
      scope: 'runtime' as const,
      pairedAt: now,
      lastSeenAt: now,
      pairingReach: 'this-computer' as const,
      parentDeviceId,
      runtimeLease: true as const,
      grants: [...grants],
      callerFingerprint: createHash('sha256')
        .update(JSON.stringify(['managed-workspace', parentDeviceId, subjectKey]))
        .digest('hex')
    }
    const expiresAt = now + MANAGED_RUNTIME_SESSION_LIFETIME_MS
    const timer = this.expirationTimer(device.deviceId)
    this.leases.set(device.deviceId, {
      device,
      parent: { ...parent, grants: [...(parent.grants ?? [])] },
      expiresAt,
      timer
    })
    return { deviceId: device.deviceId, token: device.token, expiresAt }
  }

  renew(parentDeviceId: string, deviceId: string): { expiresAt: number } {
    const lease = this.current(deviceId)
    if (!lease || lease.parent.deviceId !== parentDeviceId) {
      throw new Error('managed_session_unavailable')
    }
    clearTimeout(lease.timer)
    lease.expiresAt = Date.now() + MANAGED_RUNTIME_SESSION_LIFETIME_MS
    lease.timer = this.expirationTimer(deviceId)
    return { expiresAt: lease.expiresAt }
  }

  revoke(parentDeviceId: string, deviceId: string): boolean {
    const lease = this.leases.get(deviceId)
    return lease?.parent.deviceId === parentDeviceId && this.retire(deviceId)
  }

  resolve(deviceId: string): DeviceEntry | null {
    return this.current(deviceId)?.device ?? null
  }

  validateToken(token: string): DeviceEntry | null {
    const lease = [...this.leases.values()].find((entry) => entry.device.token === token)
    return lease ? this.resolve(lease.device.deviceId) : null
  }

  retireParent(parentDeviceId: string): void {
    for (const lease of this.leases.values()) {
      if (lease.parent.deviceId === parentDeviceId) {
        this.retire(lease.device.deviceId)
      }
    }
  }

  onRetired(listener: (deviceId: string) => void): () => void {
    this.retirementListeners.add(listener)
    return () => this.retirementListeners.delete(listener)
  }

  dispose(): void {
    for (const deviceId of this.leases.keys()) {
      this.retire(deviceId)
    }
    this.retirementListeners.clear()
  }

  private current(deviceId: string): Lease | null {
    const lease = this.leases.get(deviceId)
    if (!lease) {
      return null
    }
    const parent = this.resolveParent(lease.parent.deviceId)
    const original = devicePrincipalOf(lease.parent)
    if (
      lease.expiresAt <= Date.now() ||
      parent?.scope !== 'runtime' ||
      !isStillAuthenticated(parent, {
        deviceId: original.deviceId,
        credentialRevision: original.credentialRevision,
        ...(lease.parent.token ? { deviceToken: lease.parent.token } : {})
      }) ||
      !sameGrants(parent, lease.parent.grants ?? [])
    ) {
      this.retire(deviceId)
      return null
    }
    return lease
  }

  private prune(): void {
    for (const deviceId of this.leases.keys()) {
      this.current(deviceId)
    }
  }

  private expirationTimer(deviceId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.retire(deviceId), MANAGED_RUNTIME_SESSION_LIFETIME_MS)
    timer.unref?.()
    return timer
  }

  private retire(deviceId: string): boolean {
    const lease = this.leases.get(deviceId)
    if (!lease) {
      return false
    }
    this.leases.delete(deviceId)
    clearTimeout(lease.timer)
    for (const listener of this.retirementListeners) {
      try {
        listener(deviceId)
      } catch (error) {
        console.error('[runtime] Failed to close a retired managed session:', error)
      }
    }
    return true
  }
}
