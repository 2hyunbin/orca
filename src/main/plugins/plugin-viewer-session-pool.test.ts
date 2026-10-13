import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_VIEWER_SESSION_LIMIT,
  PluginViewerSessionPool,
  type PluginViewerSessionOwner
} from './plugin-viewer-session-pool'

const owner: PluginViewerSessionOwner = {
  hostWebContentsId: 7,
  tabId: 'opened-document',
  pluginKey: 'community.viewer',
  pluginGeneration: 1
}

function deferred() {
  let finish = (): void => {}
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { promise, finish }
}

function fixture() {
  const dependencies = {
    getSession: vi.fn((partition: string) => ({ partition })),
    prepare: vi.fn(async () => {}),
    clear: vi.fn(async () => {})
  }
  return { dependencies, pool: new PluginViewerSessionPool(dependencies) }
}

class Guest extends EventEmitter {
  destroyed = false
  close = vi.fn(() => {})
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

describe('private viewer session leases', () => {
  it('reserves capacity before async preparation and denies admission until prepared', async () => {
    const { pool, dependencies } = fixture()
    const barrier = deferred()
    dependencies.prepare.mockImplementation(() => barrier.promise)
    const acquisitions = Array.from({ length: PLUGIN_VIEWER_SESSION_LIMIT }, () =>
      pool.acquire(owner)
    )
    await expect(pool.acquire(owner)).rejects.toThrow('plugin_viewer_session_limit')
    expect(dependencies.getSession).toHaveBeenCalledTimes(PLUGIN_VIEWER_SESSION_LIMIT)
    const first = dependencies.getSession.mock.results[0].value
    expect(pool.isAdmissibleAttach(owner.hostWebContentsId, first.partition, 'anything')).toBe(
      false
    )
    barrier.finish()
    const leases = await Promise.all(acquisitions)
    expect(new Set(leases.map((lease) => lease.partition)).size).toBe(PLUGIN_VIEWER_SESSION_LIMIT)
    expect(leases.every((lease) => !lease.partition.startsWith('persist:'))).toBe(true)
    await pool.dispose()
  })

  it('admits only the exact URL, partition and host; binds one guest to the session identity', async () => {
    const { pool } = fixture()
    const lease = await pool.acquire(owner)
    const guest = new Guest()
    expect(pool.isAdmissibleAttach(7, lease.partition, lease.url)).toBe(true)
    expect(pool.isAdmissibleAttach(8, lease.partition, lease.url)).toBe(false)
    for (const url of [
      `${lease.url}?x`,
      `${lease.url}other`,
      lease.url.replace('://', '://other.')
    ]) {
      expect(pool.isAdmissibleAttach(7, lease.partition, url)).toBe(false)
    }
    expect(pool.isAdmissibleAttach(7, 'other-partition', lease.url)).toBe(false)
    expect(pool.bindGuest(lease.id, 7, lease.session, guest)).toBe(false)
    expect(pool.reserveAttach(8, lease.partition, lease.url)).toBe(false)
    expect(pool.reserveAttach(7, lease.partition, lease.url)).toBe(true)
    expect(pool.reserveAttach(7, lease.partition, lease.url)).toBe(false)
    expect(pool.bindGuest(lease.id, 7, { partition: lease.partition }, guest)).toBe(false)
    expect(pool.bindGuest(lease.id, 8, lease.session, guest)).toBe(false)
    expect(pool.bindGuest(lease.id, 7, lease.session, guest)).toBe(true)
    expect(pool.isAdmissibleAttach(7, lease.partition, lease.url)).toBe(false)
    expect(pool.bindGuest(lease.id, 7, lease.session, new Guest())).toBe(false)
    const retirement = pool.retire(lease.id)
    guest.destroy()
    await retirement
    await pool.dispose()
  })

  it('withdraws synchronously but waits for guest destruction before clearing or reusing', async () => {
    const { pool, dependencies } = fixture()
    const lease = await pool.acquire(owner)
    const guest = new Guest()
    pool.reserveAttach(7, lease.partition, lease.url)
    pool.bindGuest(lease.id, 7, lease.session, guest)
    const retirement = pool.retire(lease.id)
    expect(pool.isCurrent(lease)).toBe(false)
    expect(pool.isAdmissibleAttach(7, lease.partition, lease.url)).toBe(false)
    await vi.waitFor(() => expect(guest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false }))
    expect(dependencies.clear).not.toHaveBeenCalled()
    const other = await pool.acquire(owner)
    expect(other.partition).not.toBe(lease.partition)
    guest.destroy()
    await retirement
    const replacement = await pool.acquire(owner)
    expect(replacement.session).toBe(lease.session)
    expect(replacement.id).not.toBe(lease.id)
    expect(replacement.url).not.toBe(lease.url)
    await pool.retire(lease.id)
    expect(pool.isCurrent(replacement)).toBe(true)
    expect(pool.isPrivateSession(lease.session)).toBe(true)
    await pool.dispose()
  })

  it('does not reuse a slot until storage cleanup has completed', async () => {
    const { pool, dependencies } = fixture()
    const lease = await pool.acquire(owner)
    const barrier = deferred()
    dependencies.clear.mockImplementationOnce(() => barrier.promise)
    const retirement = pool.retire(lease.id)
    const other = await pool.acquire(owner)
    expect(other.partition).not.toBe(lease.partition)
    barrier.finish()
    await retirement
    expect((await pool.acquire(owner)).partition).toBe(lease.partition)
    await pool.dispose()
  })

  it('quarantines failed cleanup for the rest of this pool lifetime', async () => {
    const { pool, dependencies } = fixture()
    const lease = await pool.acquire(owner)
    dependencies.clear.mockRejectedValueOnce(new Error('storage failure'))
    await expect(pool.retire(lease.id)).rejects.toThrow('storage failure')
    expect(pool.isPrivateSession(lease.session)).toBe(true)
    expect((await pool.acquire(owner)).partition).not.toBe(lease.partition)
    await pool.dispose()
  })

  it('quarantines partial preparation even when its cleanup fails', async () => {
    const { pool, dependencies } = fixture()
    dependencies.prepare.mockRejectedValueOnce(new Error('proxy failure'))
    dependencies.clear.mockRejectedValueOnce(new Error('cleanup failure'))
    await expect(pool.acquire(owner)).rejects.toThrow('proxy failure')
    const failedSession = dependencies.getSession.mock.results[0].value
    expect(pool.isPrivateSession(failedSession)).toBe(true)
    expect((await pool.acquire(owner)).session).not.toBe(failedSession)
    await pool.dispose()
  })

  it('retires only the requested host and snapshots mutable owner arguments', async () => {
    const { pool } = fixture()
    const mutable = { ...owner }
    const first = await pool.acquire(mutable)
    mutable.hostWebContentsId = 99
    mutable.pluginGeneration = 99
    const second = await pool.acquire(mutable)
    expect(first.owner).toEqual(owner)
    expect(Object.isFrozen(first.owner)).toBe(true)
    await pool.retireOwner(7)
    expect(pool.isCurrent(first)).toBe(false)
    expect(pool.isCurrent(second)).toBe(true)
    await pool.dispose()
  })

  it('fences disposal during preparation and waits before clearing the session', async () => {
    const { pool, dependencies } = fixture()
    const barrier = deferred()
    dependencies.prepare.mockImplementationOnce(() => barrier.promise)
    const acquisition = pool.acquire(owner)
    const rejected = expect(acquisition).rejects.toThrow('plugin_viewer_pool_closed')
    const disposal = pool.dispose()
    await Promise.resolve()
    expect(dependencies.clear).not.toHaveBeenCalled()
    barrier.finish()
    await rejected
    await disposal
    expect(dependencies.clear).toHaveBeenCalledTimes(1)
    await expect(pool.acquire(owner)).rejects.toThrow('plugin_viewer_pool_closed')
  })

  it('fences owner retirement during preparation without racing cleanup', async () => {
    const { pool, dependencies } = fixture()
    const barrier = deferred()
    dependencies.prepare.mockImplementationOnce(() => barrier.promise)
    const acquisition = pool.acquire(owner)
    const rejected = expect(acquisition).rejects.toThrow('plugin_viewer_pool_closed')
    const retirement = pool.retireOwner(7)
    await Promise.resolve()
    expect(dependencies.clear).not.toHaveBeenCalled()
    barrier.finish()
    await rejected
    await retirement
    expect(dependencies.clear).toHaveBeenCalledTimes(1)
    expect((await pool.acquire(owner)).partition).toBe(
      dependencies.getSession.mock.results[0].value.partition
    )
    await pool.dispose()
  })

  it('quarantines a guest whose close fails and retains its private-session identity', async () => {
    const { pool, dependencies } = fixture()
    const lease = await pool.acquire(owner)
    const guest = new Guest()
    guest.close.mockImplementation(() => {
      throw new Error('close failure')
    })
    pool.reserveAttach(7, lease.partition, lease.url)
    pool.bindGuest(lease.id, 7, lease.session, guest)
    await expect(pool.retire(lease.id)).rejects.toThrow('close failure')
    expect(dependencies.clear).not.toHaveBeenCalled()
    expect(guest.listenerCount('destroyed')).toBe(0)
    expect(pool.isPrivateSession(lease.session)).toBe(true)
    expect((await pool.acquire(owner)).partition).not.toBe(lease.partition)
    await pool.dispose()
  })
})
