import { randomUUID } from 'node:crypto'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { createMockStore } from '../ssh/ssh-connection-store-test-fixture'
import { pluginEnvironmentRecipeSchema } from '../../shared/plugins/plugin-environment-recipe-artifact'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { setSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { getPluginsDataDir, getUserPluginsDir } from './plugin-discovery'
import { installPluginFromLocalPath, removeInstalledPlugin } from './plugin-install'
import {
  createPluginEnvironmentProviderInstallFixture,
  disposePluginEnvironmentProviderInstallFixtures
} from './plugin-environment-provider-install-fixture'

const connection = {
  type: 'ssh' as const,
  host: 'box.internal',
  port: 22,
  username: 'developer',
  projectRoot: '/projects'
}
async function fixture(options: { pageSize?: number } = {}) {
  const f = await createPluginEnvironmentProviderInstallFixture(options)
  await f.approve()
  await f.service.environmentProviders.configure(f.review)
  const resource = {
    id: 'devbox',
    name: 'Existing devbox',
    revision: 'r1',
    lifetime: 'long-lived' as const,
    state: 'running' as const,
    connection
  }
  await writeFile(join(f.cwd, 'backend.json'), JSON.stringify({ devbox: resource }))
  const persisted = { ...createMockStore(), flushPendingOrThrowAsync: vi.fn(async () => {}) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements the persistence operations exercised by SSH target registration and durable flush.
  const store = new SshConnectionStore(persisted as never)
  setSshTargetRegistryStore(store)
  return { ...f, store, persisted, resource, ssh: f.service.environmentProviders.ssh }
}
afterEach(async () => {
  setSshTargetRegistryStore(null)
  await disposePluginEnvironmentProviderInstallFixtures()
})

describe('provider connection handoff reuses reviewed host ownership', () => {
  it('issues a fresh lease after re-enabling the same reviewed provider without reviving the old one', async () => {
    const f = await fixture()
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const target = await f.ssh.save('window-one', preview.ticketId)
    const old = await f.ssh.authorize(target)
    const marker = await readFile(join(f.cwd, 'started'), 'utf8')
    await f.disableProvider()
    expect(old.signal.aborted).toBe(true)
    await f.enable()
    const restored = await f.ssh.authorize(target)
    expect(restored.signal).not.toBe(old.signal)
    expect(restored.signal.aborted).toBe(false)
    expect(restored.isCurrent()).toBe(true)
    expect(old.isCurrent()).toBe(false)
    expect(await readFile(join(f.cwd, 'started'), 'utf8')).toBe(marker)
  })
  it('preserves a reviewed SSH lease through repeated no-op refresh and activation reconciliation', async () => {
    const f = await fixture()
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const target = await f.ssh.save('window-one', preview.ticketId)
    const lease = await f.ssh.authorize(target)
    const marker = await readFile(join(f.cwd, 'started'), 'utf8')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const reconcile = f.service.contentPacks.reconcile.bind(f.service.contentPacks)
    const heldRefresh = vi
      .spyOn(f.service.contentPacks, 'reconcile')
      .mockImplementationOnce(async (...args) => {
        entered.resolve()
        await release.promise
        return reconcile(...args)
      })
    const pending = f.service.refresh()
    await entered.promise
    expect(lease.isCurrent()).toBe(true)
    expect(lease.signal.aborted).toBe(false)
    release.resolve()
    await pending
    heldRefresh.mockRestore()
    for (let i = 0; i < 3; i++) {
      const refreshed = f.service.refresh()
      expect(lease.isCurrent()).toBe(true)
      await refreshed
      await f.service.reconcileActivationState()
      expect(lease.isCurrent()).toBe(true)
      expect(lease.signal.aborted).toBe(false)
    }
    expect((await f.ssh.authorize(target)).signal).toBe(lease.signal)
    expect(f.store.getTarget(target.id)).toEqual(target)
    expect(await readFile(join(f.cwd, 'started'), 'utf8')).toBe(marker)
  })
  it('does not retire another provider when an unrelated installed package is removed', async () => {
    const f = await fixture()
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const target = await f.ssh.save('window-one', preview.ticketId)
    const lease = await f.ssh.authorize(target)
    const neighborPath = join(f.root, 'neighbor-source')
    await cp(f.sourceDir, neighborPath, { recursive: true })
    const manifestPath = join(neighborPath, 'orca-plugin.json')
    const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, publisher: 'community' }))
    const pluginsDir = getUserPluginsDir(f.service.options.userDataPath)
    const installed = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath: neighborPath,
      hostVersion: f.service.options.hostVersion
    })
    expect(installed.ok).toBe(true)
    await f.service.refresh()
    await f.service.removePlugin('community.platform', () =>
      removeInstalledPlugin({
        pluginsDir,
        pluginsDataDir: getPluginsDataDir(f.service.options.userDataPath),
        pluginKey: 'community.platform'
      })
    )
    await f.service.refresh()
    expect(lease.signal.aborted).toBe(false)
    expect(lease.isCurrent()).toBe(true)
    await f.disableProvider()
    expect(lease.signal.aborted).toBe(true)
    expect(lease.isCurrent()).toBe(false)
  })
  it('refreshes through the actual provider CLI and binds a durable visible target to the private review', async () => {
    const f = await fixture()
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    expect(preview.resource.connection).toEqual(connection)
    expect(f.store.listTargets()).toEqual([])
    preview.resource.connection!.host = 'renderer-forged.internal'
    await expect(f.ssh.save('window-two', preview.ticketId)).rejects.toThrow('unavailable')
    const target = await f.ssh.save('window-one', preview.ticketId, '/keys/developer')
    expect(target).toMatchObject({
      host: connection.host,
      identityFile: '/keys/developer',
      allowRemoteCliControl: false,
      environmentProvider: {
        binding: { contextId: f.review.contextId },
        resourceId: 'devbox',
        resourceRevision: 'r1'
      }
    })
    expect(f.persisted.flushPendingOrThrowAsync).toHaveBeenCalledOnce()
    expect(f.store.listTargets()).toHaveLength(1)
    expect(f.store.lastRepoReadoptions).toEqual([])
    const lease = await f.ssh.authorize(target)
    expect(lease.isCurrent()).toBe(true)
    await expect(f.ssh.save('window-one', preview.ticketId)).rejects.toThrow('unavailable')
  })
  it('does not create a target from an earlier revision, sleeping machine, or withdrawn window review', async () => {
    const f = await fixture()
    await expect(f.ssh.prepare('window-one', f.review, 'devbox', 'r0')).rejects.toThrow('changed')
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    f.ssh.revokeOwner('window-one')
    await expect(f.ssh.save('window-one', preview.ticketId)).rejects.toThrow('unavailable')
    const { connection: _connection, ...resource } = f.resource
    await writeFile(
      join(f.cwd, 'backend.json'),
      JSON.stringify({ devbox: { ...resource, state: 'sleeping', revision: 'r2' } })
    )
    await expect(f.ssh.prepare('window-one', f.review, 'devbox', 'r2')).rejects.toThrow('changed')
    expect(f.store.listTargets()).toEqual([])
  })
  it('revokes a live lease before sleep and keeps saved ownership and resource history', async () => {
    const f = await fixture()
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const target = await f.ssh.save('window-one', preview.ticketId)
    const lease = await f.ssh.authorize(target)
    let revoked = false
    lease.signal.addEventListener('abort', () => {
      revoked = true
    })
    const result = await f.service.environmentProviders.execute(f.review, {
      protocolVersion: 2,
      contextId: f.review.contextId,
      providerId: f.review.providerId,
      operationId: randomUUID(),
      action: 'sleep',
      resourceId: 'devbox',
      expectedRevision: 'r1'
    })
    expect(revoked).toBe(true)
    expect(lease.isCurrent()).toBe(false)
    expect(result).toMatchObject({
      kind: 'executed',
      result: { kind: 'completed', response: { resource: { state: 'sleeping' } } }
    })
    expect(f.store.getTarget(target.id)?.environmentProvider).toEqual(target.environmentProvider)
    await expect(f.ssh.authorize(target)).rejects.toThrow('no longer current')
  })
  it('withdraws a connection on disable and refuses edited or different saved registrations', async () => {
    const f = await fixture()
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const target = await f.ssh.save('window-one', preview.ticketId)
    await expect(f.ssh.authorize({ ...target, host: 'forged.internal' })).rejects.toThrow(
      'registration changed'
    )
    await expect(f.ssh.authorize({ ...target, id: 'unrelated-target' })).rejects.toThrow(
      'registration changed'
    )
    const lease = await f.ssh.authorize(target)
    await f.disable()
    expect(lease.signal.aborted).toBe(true)
    expect(lease.isCurrent()).toBe(false)
    await expect(f.ssh.authorize(target)).rejects.toThrow('approval')
    expect(f.store.getTarget(target.id)).toBeDefined()
  })
  it('retires a stale live lease when a fresh list confirms changed machine state', async () => {
    const f = await fixture()
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const target = await f.ssh.save('window-one', preview.ticketId)
    const lease = await f.ssh.authorize(target)
    const { connection: _connection, ...resource } = f.resource
    await writeFile(
      join(f.cwd, 'backend.json'),
      JSON.stringify({ devbox: { ...resource, state: 'deleted', revision: 'r2' } })
    )
    await f.service.environmentProviders.execute(f.review, {
      protocolVersion: 2,
      contextId: f.review.contextId,
      providerId: f.review.providerId,
      operationId: randomUUID(),
      action: 'list'
    })
    expect(lease.signal.aborted).toBe(true)
    const snapshot = await f.service.environmentProviders.snapshot(f.review)
    expect(snapshot.resources).toMatchObject([{ id: 'devbox', state: 'deleted' }])
    expect(await readFile(join(f.cwd, 'started'), 'utf8')).toMatch(/^\d+$/)
  })
  it('follows fresh inventory pages before reviewing a selected machine', async () => {
    const f = await fixture({ pageSize: 1 })
    await writeFile(
      join(f.cwd, 'backend.json'),
      JSON.stringify({ other: { ...f.resource, id: 'other' }, devbox: f.resource })
    )
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    expect(preview.resource.id).toBe('devbox')
    const snapshot = await f.service.environmentProviders.snapshot(f.review)
    expect(snapshot.resources.map((entry) => entry.id)).toEqual(['other', 'devbox'])
    expect(snapshot.operations).toHaveLength(2)
  })
  it('withdraws a ticket consumed by a save that is still checking host authority', async () => {
    const f = await fixture()
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const pending = f.ssh.save('window-one', preview.ticketId)
    f.ssh.revokeOwner('window-one')
    await expect(pending).rejects.toThrow('review changed')
    expect(f.store.listTargets()).toEqual([])
  })
  it('keeps existing devbox contact during creation of a different sandbox and refuses stale mutations before retirement', async () => {
    const f = await fixture()
    const preview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const target = await f.ssh.save('window-one', preview.ticketId)
    const lease = await f.ssh.authorize(target)
    await expect(
      f.service.environmentProviders.execute(f.review, {
        protocolVersion: 2,
        contextId: f.review.contextId,
        providerId: f.review.providerId,
        operationId: randomUUID(),
        action: 'sleep',
        resourceId: 'devbox',
        expectedRevision: 'wrong-revision'
      })
    ).rejects.toThrow('revision')
    expect(lease.signal.aborted).toBe(false)
    const result = await f.service.environmentProviders.execute(f.review, {
      protocolVersion: 2,
      contextId: f.review.contextId,
      providerId: f.review.providerId,
      operationId: randomUUID(),
      action: 'create',
      parameters: {}
    })
    expect(result).toMatchObject({
      kind: 'executed',
      result: { kind: 'completed', response: { resource: { id: 'sandbox' } } }
    })
    expect(lease.signal.aborted).toBe(false)
    expect(lease.isCurrent()).toBe(true)
  })
  it('requires fresh SSH review after source migration and preserves target identity and generation', async () => {
    const f = await fixture()
    const first = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const target = await f.ssh.save('window-one', first.ticketId, '/keys/developer')
    const lease = await f.ssh.authorize(target)
    const recipePath = join(f.sourceDir, 'recipe.json')
    const recipe = pluginEnvironmentRecipeSchema.parse(
      JSON.parse(await readFile(recipePath, 'utf8'))
    )
    recipe.commands.list.args.push('--', 'updated-provider')
    await writeFile(recipePath, JSON.stringify(recipe))
    await f.reinstall()
    await f.approve()
    const entry = (await f.service.environmentProviders.list())[0]!
    const review = { ...entry.review, contextId: f.review.contextId }
    const migration = await f.service.environmentProviders.prepareMigration('window-one', {
      review,
      queryId: randomUUID()
    })
    await f.service.environmentProviders.commitMigration('window-one', {
      ticketId: migration.ticketId
    })
    expect(lease.signal.aborted).toBe(true)
    await expect(f.ssh.authorize(target)).rejects.toThrow()
    const fresh = await f.ssh.prepare('window-one', review, 'devbox', 'r1')
    const replacement = await f.ssh.save('window-one', fresh.ticketId)
    expect(replacement.id).toBe(target.id)
    expect(replacement.generation).toBe(target.generation)
    expect(replacement.identityFile).toBe('/keys/developer')
    expect(replacement.environmentProvider?.binding).toEqual(migration.nextBinding)
    expect((await f.ssh.authorize(replacement)).isCurrent()).toBe(true)
  })
  it('does not let source lineage silently retarget a saved SSH endpoint', async () => {
    const f = await fixture()
    const first = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const target = await f.ssh.save('window-one', first.ticketId)
    await writeFile(
      join(f.cwd, 'backend.json'),
      JSON.stringify({
        devbox: { ...f.resource, connection: { ...connection, host: 'different.internal' } }
      })
    )
    const migration = await f.service.environmentProviders.prepareMigration('window-one', {
      review: f.review,
      queryId: randomUUID()
    })
    await f.service.environmentProviders.commitMigration('window-one', {
      ticketId: migration.ticketId
    })
    const fresh = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    await expect(f.ssh.save('window-one', fresh.ticketId)).rejects.toThrow(
      'connection details changed'
    )
    expect(f.store.getTarget(target.id)).toEqual(target)
  })
  it('keeps a live SSH lease valid throughout a withdrawn migration preflight', async () => {
    const f = await fixture()
    const connectionReview = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
    const target = await f.ssh.save('window-one', connectionReview.ticketId)
    const lease = await f.ssh.authorize(target)
    const migration = await f.service.environmentProviders.prepareMigration('window-one', {
      review: f.review,
      queryId: randomUUID()
    })
    const committing = f.service.environmentProviders.commitMigration('window-one', {
      ticketId: migration.ticketId
    })
    expect(lease.isCurrent()).toBe(true)
    f.service.environmentProviders.revokeMigrationOwner('window-one')
    await expect(committing).rejects.toThrow('authority changed')
    expect(lease.isCurrent()).toBe(true)
    expect(lease.signal.aborted).toBe(false)
    expect(f.store.getTarget(target.id)).toEqual(target)
  })
})
