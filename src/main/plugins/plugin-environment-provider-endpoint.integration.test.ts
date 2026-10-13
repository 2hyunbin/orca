import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { disposePluginEnvironmentProviderInstallFixtures } from './plugin-environment-provider-install-fixture'
import { createProviderSshFixture } from './plugin-environment-provider-ssh-fixture'
import type { SshTarget } from '../../shared/ssh-types'

afterEach(async () => {
  setSshTargetRegistryStore(null)
  await disposePluginEnvironmentProviderInstallFixtures()
})

async function fixture(retireTarget?: (target: SshTarget) => Promise<void>) {
  const f = await createProviderSshFixture(retireTarget ? { retireTarget } : {})
  const first = await f.ssh.prepare('window-one', f.review, 'devbox', 'r1')
  const target = structuredClone(await f.ssh.save('window-one', first.ticketId, '/keys/company'))
  const lease = await f.ssh.authorize(target)
  const resource = {
    ...f.resource,
    revision: 'r2',
    connection: { ...f.resource.connection, host: 'replacement.internal', port: 2222 }
  }
  await writeFile(join(f.cwd, 'backend.json'), JSON.stringify({ devbox: resource }))
  const review = await f.ssh.prepare('window-one', f.review, 'devbox', 'r2')
  return { ...f, target, lease, resource, preview: review }
}

describe('provider endpoint updates require explicit current connection review', () => {
  it('releases declined reviews immediately and confines cancellation to their owner', async () => {
    const f = await fixture(async () => {})
    expect(f.ssh.discard('window-two', f.preview.ticketId)).toBe(false)
    expect(f.ssh.discard('window-one', f.preview.ticketId)).toBe(true)
    await expect(f.ssh.save('window-one', f.preview.ticketId, undefined, true)).rejects.toThrow(
      'unavailable'
    )
    for (let i = 0; i < 35; i++) {
      const review = await f.ssh.prepare('window-one', f.review, 'devbox', 'r2')
      expect(f.ssh.discard('window-one', review.ticketId)).toBe(true)
    }
    expect(f.store.getTarget(f.target.id)).toEqual(f.target)
  })
  it('shows the old endpoint without changing the saved target or accepting an ordinary save', async () => {
    const retire = vi.fn(async (_target: SshTarget) => {})
    const f = await fixture(retire)
    expect(f.preview.endpointUpdate).toEqual({
      previousConnection: f.target.environmentProvider?.connection,
      savedIdentityFile: true
    })
    expect(f.preview.resource.connection).toEqual(f.resource.connection)
    f.preview.endpointUpdate!.previousConnection.host = 'renderer-forged.internal'
    expect(f.store.getTarget(f.target.id)).toEqual(f.target)
    expect(f.lease.signal.aborted).toBe(true)
    await expect(f.ssh.save('window-one', f.preview.ticketId)).rejects.toThrow('explicitly review')
    expect(f.store.getTarget(f.target.id)).toEqual(f.target)
    expect(retire).not.toHaveBeenCalled()
  })
  it('retires the exact old connection before updating the same host and issues current authority', async () => {
    const retire = vi.fn(async (target: SshTarget) => {
      expect(target.host).toBe('box.internal')
      expect(target.identityFile).toBe('/keys/company')
    })
    const f = await fixture(retire)
    const beforeCalls = await f.service.environmentProviders.snapshot(f.review)
    f.persisted.folderWorkspaces.push({
      id: 'folder-one',
      projectGroupId: 'group-one',
      name: 'Existing folder',
      folderPath: '/projects',
      connectionId: f.target.id,
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: true,
      sortOrder: 1,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    })
    f.persisted.repos.push({
      id: 'repo-one',
      path: '/projects/repo',
      displayName: 'Existing repository',
      badgeColor: '',
      addedAt: 1,
      connectionId: f.target.id
    })
    const workspaces = structuredClone({
      repos: f.persisted.repos,
      folders: f.persisted.folderWorkspaces
    })
    const updated = await f.ssh.save('window-one', f.preview.ticketId, undefined, true)
    expect(retire).toHaveBeenCalledExactlyOnceWith(f.target)
    expect(updated.id).toBe(f.target.id)
    expect(updated.generation).not.toBe(f.target.generation)
    expect(updated.identityFile).toBe('/keys/company')
    expect(updated.host).toBe('replacement.internal')
    expect(updated.port).toBe(2222)
    expect(updated.environmentProvider?.resourceRevision).toBe('r2')
    expect({ repos: f.persisted.repos, folders: f.persisted.folderWorkspaces }).toEqual(workspaces)
    expect((await f.ssh.authorize(updated)).isCurrent()).toBe(true)
    expect(f.lease.isCurrent()).toBe(false)
    await expect(f.ssh.authorize(f.target)).rejects.toThrow()
    expect(await f.service.environmentProviders.snapshot(f.review)).toEqual(beforeCalls)
    expect(f.persisted.flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
    await expect(f.ssh.save('window-one', f.preview.ticketId, undefined, true)).rejects.toThrow(
      'unavailable'
    )
  })
  it('requires an execution-host retirement implementation', async () => {
    const f = await fixture()
    await expect(f.ssh.save('window-one', f.preview.ticketId, undefined, true)).rejects.toThrow(
      'safely retire'
    )
    expect(f.store.getTarget(f.target.id)).toEqual(f.target)
  })
  it('does not publish a new endpoint after retirement fails', async () => {
    const f = await fixture(async () => {
      throw new Error('Old transport could not be retired')
    })
    await expect(f.ssh.save('window-one', f.preview.ticketId, undefined, true)).rejects.toThrow(
      'could not be retired'
    )
    expect(f.store.getTarget(f.target.id)).toEqual(f.target)
    expect(f.persisted.flushPendingOrThrowAsync).toHaveBeenCalledOnce()
  })
  it('pins the saved registration and credentials through asynchronous retirement', async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const f = await fixture(async () => {
      entered.resolve()
      await release.promise
    })
    const save = f.ssh.save('window-one', f.preview.ticketId, undefined, true)
    const rejection = expect(save).rejects.toThrow('changed after its endpoint was reviewed')
    await entered.promise
    f.persisted.updateSshTarget(f.target.id, { identityFile: '/keys/other-client' })
    release.resolve()
    await rejection
    expect(f.store.getTarget(f.target.id)?.host).toBe('box.internal')
    expect(f.store.getTarget(f.target.id)?.identityFile).toBe('/keys/other-client')
    expect(f.persisted.allocateSshTargetGeneration).toHaveBeenCalledOnce()
  })
  it('withdraws a consuming review on window navigation without publishing the endpoint', async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const f = await fixture(async () => {
      entered.resolve()
      await release.promise
    })
    const save = f.ssh.save('window-one', f.preview.ticketId, undefined, true)
    const rejection = expect(save).rejects.toThrow('review changed')
    await entered.promise
    f.ssh.revokeOwner('window-one')
    release.resolve()
    await rejection
    expect(f.store.getTarget(f.target.id)).toEqual(f.target)
  })
  it('refuses another window and a competing old registration review', async () => {
    const retire = vi.fn(async (_target: SshTarget) => {})
    const f = await fixture(retire)
    const competitor = await f.ssh.prepare('window-two', f.review, 'devbox', 'r2')
    await expect(f.ssh.save('window-two', f.preview.ticketId, undefined, true)).rejects.toThrow(
      'unavailable'
    )
    await f.ssh.save('window-one', f.preview.ticketId, undefined, true)
    await expect(f.ssh.save('window-two', competitor.ticketId, undefined, true)).rejects.toThrow(
      'changed during connection review'
    )
    expect(retire).toHaveBeenCalledOnce()
    expect(f.persisted.allocateSshTargetGeneration).toHaveBeenCalledTimes(2)
  })
  it('refuses provider withdrawal while the old transport is retiring', async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const f = await fixture(async () => {
      entered.resolve()
      await release.promise
    })
    const save = f.ssh.save('window-one', f.preview.ticketId, undefined, true)
    const rejection = expect(save).rejects.toThrow('review changed')
    await entered.promise
    await f.disableProvider()
    release.resolve()
    await rejection
    expect(f.store.getTarget(f.target.id)).toEqual(f.target)
  })
  it('rejects foreign saved ownership before retiring any target', async () => {
    const retire = vi.fn(async (_target: SshTarget) => {})
    const f = await fixture(retire)
    const owner = f.target.environmentProvider!
    f.persisted.updateSshTarget(f.target.id, {
      environmentProvider: { ...owner, binding: { ...owner.binding, sourceDigest: 'c'.repeat(64) } }
    })
    const review = await f.ssh.prepare('window-one', f.review, 'devbox', 'r2')
    await expect(f.ssh.save('window-one', review.ticketId, undefined, true)).rejects.toThrow(
      'another environment owner'
    )
    expect(retire).not.toHaveBeenCalled()
    expect(f.store.getTarget(f.target.id)?.host).toBe('box.internal')
  })
})
