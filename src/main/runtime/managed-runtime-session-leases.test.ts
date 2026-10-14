import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceEntry } from './device-entry'
import { ManagedRuntimeSessionLeases } from './managed-runtime-session-leases'
import { MANAGED_RUNTIME_SESSION_LIFETIME_MS } from '../../shared/managed-runtime-session-contract'

const pools: ManagedRuntimeSessionLeases[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) {
    pool.dispose()
  }
  vi.useRealTimers()
})
function setup() {
  let parent: DeviceEntry | null = {
    deviceId: 'controller',
    token: 'private-controller-token',
    name: 'Controller',
    scope: 'runtime',
    pairedAt: 1,
    lastSeenAt: 1
  }
  const pool = new ManagedRuntimeSessionLeases((id) => (id === parent?.deviceId ? parent : null))
  pools.push(pool)
  return {
    pool,
    change: (next: DeviceEntry | null) => {
      parent = next
    },
    parent: () => parent
  }
}

describe('managed runtime session leases', () => {
  it('mints distinct bounded runtime credentials with stable scoped caller identity', () => {
    const { pool } = setup()
    const one = pool.open('controller', 'installation', 'Laptop')
    const two = pool.open('controller', 'installation', 'Laptop')
    expect(one.token).not.toBe(two.token)
    expect(one.deviceId).not.toBe(two.deviceId)
    expect(pool.validateToken(one.token)).toMatchObject({
      scope: 'runtime',
      runtimeLease: true,
      grants: []
    })
    expect(pool.resolve(one.deviceId)?.callerFingerprint).toBe(
      pool.resolve(two.deviceId)?.callerFingerprint
    )
    expect(pool.resolve(one.deviceId)?.callerFingerprint).not.toBe(
      pool.resolve(pool.open('controller', 'other', 'Other').deviceId)?.callerFingerprint
    )
  })
  it('expires and notifies retirement without incoming traffic', () => {
    vi.useFakeTimers()
    const { pool } = setup()
    const retired = vi.fn()
    pool.onRetired(retired)
    const grant = pool.open('controller', 'installation', 'Laptop')
    vi.advanceTimersByTime(MANAGED_RUNTIME_SESSION_LIFETIME_MS)
    expect(retired).toHaveBeenCalledExactlyOnceWith(grant.deviceId)
    expect(pool.validateToken(grant.token)).toBeNull()
    expect(() => pool.renew('controller', grant.deviceId)).toThrow('unavailable')
  })
  it('only lets the authenticated parent renew or revoke its session', () => {
    vi.useFakeTimers()
    const { pool } = setup()
    const grant = pool.open('controller', 'installation', 'Laptop')
    expect(() => pool.renew('other', grant.deviceId)).toThrow()
    expect(pool.revoke('other', grant.deviceId)).toBe(false)
    vi.advanceTimersByTime(20_000)
    expect(pool.renew('controller', grant.deviceId).expiresAt).toBeGreaterThan(grant.expiresAt)
    vi.advanceTimersByTime(20_000)
    expect(pool.resolve(grant.deviceId)).not.toBeNull()
    expect(pool.revoke('controller', grant.deviceId)).toBe(true)
    expect(pool.resolve(grant.deviceId)).toBeNull()
  })
  it.each(['token', 'revision', 'grants', 'scope', 'removed'])(
    'retires on parent %s changes',
    (change) => {
      const { pool, parent, change: set } = setup()
      const grant = pool.open('controller', 'installation', 'Laptop')
      const original = parent()
      if (!original) {
        throw new Error('missing parent')
      }
      set(
        change === 'removed'
          ? null
          : {
              ...original,
              ...(change === 'token' ? { token: 'changed' } : {}),
              ...(change === 'revision' ? { credentialRevision: 1 } : {}),
              ...(change === 'grants' ? { grants: ['desktop-control' as const] } : {}),
              ...(change === 'scope' ? { scope: 'mobile' as const } : {})
            }
      )
      expect(pool.validateToken(grant.token)).toBeNull()
    }
  )
  it('refuses mobile and chained managed sessions as parents', () => {
    const { pool, change, parent } = setup()
    const original = parent()
    if (!original) {
      throw new Error('missing parent')
    }
    change({ ...original, scope: 'mobile' })
    expect(() => pool.open('controller', 'installation', 'Laptop')).toThrow()
    change({ ...original, runtimeLease: true })
    expect(() => pool.open('controller', 'installation', 'Laptop')).toThrow()
  })
  it('bounds sessions and releases capacity on revoke', () => {
    const { pool } = setup()
    const grants = Array.from({ length: 32 }, (_, i) =>
      pool.open('controller', String(i), 'Laptop')
    )
    expect(() => pool.open('controller', 'overflow', 'Laptop')).toThrow('capacity')
    pool.revoke('controller', grants[0].deviceId)
    expect(() => pool.open('controller', 'next', 'Laptop')).not.toThrow()
  })

  it('supports a keyed parent and snapshots its grant authority', () => {
    const { pool, change } = setup()
    const grants: DeviceEntry['grants'] = ['desktop-control']
    change({
      deviceId: 'controller',
      name: 'Keyed controller',
      scope: 'runtime',
      pairedAt: 1,
      lastSeenAt: 1,
      credentialKind: 'device-key',
      devicePublicKeyB64: 'verified-by-parent-auth',
      grants
    })
    const standard = pool.open('controller', 'installation', 'Laptop')
    expect(pool.resolve(standard.deviceId)?.grants).toEqual([])
    const grant = pool.open('controller', 'installation', 'Laptop', ['desktop-control'])
    expect(pool.resolve(grant.deviceId)?.grants).toEqual(['desktop-control'])
    grants.splice(0)
    expect(pool.resolve(grant.deviceId)).toBeNull()
  })

  it('refuses optional grants the authenticated parent does not hold', () => {
    const { pool } = setup()
    expect(() => pool.open('controller', 'installation', 'Laptop', ['desktop-control'])).toThrow(
      'grant_refused'
    )
  })
  it('parent retirement and disposal retire every session once', () => {
    const { pool } = setup()
    const retired = vi.fn()
    pool.onRetired(retired)
    pool.open('controller', 'one', 'Laptop')
    pool.open('controller', 'two', 'Laptop')
    pool.retireParent('controller')
    pool.dispose()
    expect(retired).toHaveBeenCalledTimes(2)
  })
})
