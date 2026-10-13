import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getUserPluginsDir } from './plugin-discovery'
import {
  createPluginEnvironmentProviderInstallFixture as fixture,
  disposePluginEnvironmentProviderInstallFixtures
} from './plugin-environment-provider-install-fixture'

afterEach(disposePluginEnvironmentProviderInstallFixtures)

async function populatedFixture() {
  const f = await fixture()
  await f.approve()
  await f.service.environmentProviders.configure(f.review)
  await f.service.environmentProviders.execute(f.review, {
    protocolVersion: 2,
    operationId: randomUUID(),
    contextId: f.review.contextId,
    providerId: f.review.providerId,
    action: 'list'
  })
  return f
}

describe('saved provider inventory has no execution authority', () => {
  it('keeps inventory and operations readable after disable, restart and removal without running code', async () => {
    const f = await populatedFixture()
    expect(await f.service.environmentProviders.listSaved()).toEqual([])
    const marker = await readFile(join(f.cwd, 'started'), 'utf8')
    await f.disableProvider()
    const saved = await f.service.environmentProviders.listSaved()
    expect(saved).toEqual([
      {
        executionHostId: 'local',
        providerId: f.review.providerId,
        contextId: f.review.contextId,
        configuredAt: expect.any(Number)
      }
    ])
    expect(saved[0]).not.toHaveProperty('review')
    expect(saved[0]).not.toHaveProperty('commands')
    const input = { providerId: f.review.providerId }
    const history = await f.service.environmentProviders.savedSnapshot(input)
    expect(history.snapshot.resources).toMatchObject([
      { id: 'devbox', lifetime: 'long-lived', state: 'running' }
    ])
    expect(history.snapshot.operations).toHaveLength(1)
    await expect(f.service.environmentProviders.snapshot(f.review)).rejects.toThrow()
    await expect(
      f.service.environmentProviders.savedSnapshot({ ...input, action: 'delete' })
    ).rejects.toThrow()
    expect(await readFile(join(f.cwd, 'started'), 'utf8')).toBe(marker)
    await f.service.dispose()
    const reopened = await f.reopen()
    expect(await reopened.environmentProviders.savedSnapshot(input)).toEqual(history)
    const plugin = reopened
      .getDiscovered()
      .find((entry) => entry.pluginKey === f.review.providerId.split('/')[0])
    const pluginKey = plugin?.pluginKey
    if (!pluginKey) {
      throw new Error('Fixture provider missing')
    }
    await reopened.removePlugin(pluginKey, () =>
      rm(join(getUserPluginsDir(reopened.options.userDataPath), pluginKey), {
        recursive: true,
        force: true
      })
    )
    expect(await reopened.environmentProviders.list()).toEqual([])
    expect(await reopened.environmentProviders.listSaved()).toEqual(saved)
    expect(await reopened.environmentProviders.savedSnapshot(input)).toEqual(history)
    expect(await readFile(join(f.cwd, 'started'), 'utf8')).toBe(marker)
  })

  it('returns a re-enabled provider to active management while preserving its original inventory', async () => {
    const f = await populatedFixture()
    await f.disable()
    expect(await f.service.environmentProviders.listSaved()).toHaveLength(1)
    await f.enable()
    expect(await f.service.environmentProviders.listSaved()).toEqual([])
    expect(await f.service.environmentProviders.list()).toHaveLength(1)
    expect((await f.service.environmentProviders.snapshot(f.review)).resources).toHaveLength(1)
  })

  it('denies another provider, out-of-range generation, extra execution fields and a stopped host', async () => {
    const f = await populatedFixture()
    await expect(
      f.service.environmentProviders.savedSnapshot({ providerId: 'other.platform/pods' })
    ).rejects.toThrow('No saved')
    await expect(
      f.service.environmentProviders.savedSnapshot({ providerId: f.review.providerId, offset: 1 })
    ).rejects.toThrow('offset')
    await expect(
      f.service.environmentProviders.savedSnapshot({ providerId: f.review.providerId, offset: 129 })
    ).rejects.toThrow()
    await f.service.dispose()
    await expect(f.service.environmentProviders.listSaved()).rejects.toThrow()
    await expect(
      f.service.environmentProviders.savedSnapshot({ providerId: f.review.providerId })
    ).rejects.toThrow('stopped')
  })
  it('reads the actual previous account generation after migration and disable without another CLI call', async () => {
    const f = await populatedFixture()
    const original = await f.service.environmentProviders.savedSnapshot({
      providerId: f.review.providerId
    })
    await f.selectBackendAccount('other-account')
    const preview = await f.service.environmentProviders.prepareMigration('window', {
      review: { ...f.review, contextId: 'other-account' },
      queryId: randomUUID()
    })
    await f.service.environmentProviders.commitMigration('window', { ticketId: preview.ticketId })
    await f.disableProvider()
    const markerPath = join(
      f.cwd,
      'accounts',
      Buffer.from('other-account').toString('hex'),
      'started'
    )
    const marker = await readFile(markerPath, 'utf8')
    const old = await f.service.environmentProviders.savedSnapshot({
      providerId: f.review.providerId,
      offset: 1
    })
    expect(old.snapshot).toEqual(original.snapshot)
    expect(old.previousCount).toBe(1)
    expect(old.archivedAt).toEqual(expect.any(Number))
    const current = await f.service.environmentProviders.savedSnapshot({
      providerId: f.review.providerId
    })
    expect(current.snapshot.binding.contextId).toBe('other-account')
    expect(await readFile(markerPath, 'utf8')).toBe(marker)
  })
})
