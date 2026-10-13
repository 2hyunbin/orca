import { describe, expect, it } from 'vitest'
import { SshConnectionStore } from './ssh-connection-store'
import { createMockStore } from './ssh-connection-store-test-fixture'
import type { PluginEnvironmentSshBinding } from '../../shared/plugins/plugin-environment-ssh-binding'

const owner: PluginEnvironmentSshBinding = {
  version: 1,
  binding: {
    executionHostId: 'local',
    providerId: 'company.platform/pods',
    contextId: 'company/account',
    sourceDigest: 'a'.repeat(64),
    recipeDigest: 'b'.repeat(64)
  },
  resourceId: 'pod-one',
  resourceRevision: 'r1',
  connection: {
    type: 'ssh',
    host: 'box.internal',
    port: 22,
    username: 'developer',
    projectRoot: '/projects'
  }
}
const endpoint = {
  label: 'Development machine',
  host: 'box.internal',
  port: 22,
  username: 'developer'
}
describe('provider SSH registrations preserve main-owned identity', () => {
  it('remains visible and creates a distinct target without adopting unrelated workspace tombstones', () => {
    const persisted = createMockStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements all persistence calls these target registration cases exercise.
    const store = new SshConnectionStore(persisted as never)
    const ordinary = store.addTarget(endpoint)
    const target = store.upsertEnvironmentProviderTarget(owner, endpoint)
    expect(target.id).not.toBe(ordinary.id)
    expect(store.listTargets()).toHaveLength(2)
    expect(target.owner).toBeUndefined()
    expect(target.environmentProvider).toEqual(owner)
    expect(store.lastRepoReadoptions).toEqual([])
  })
  it('preserves registration generation and a managed-server fence across the same provider resource', () => {
    const persisted = createMockStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements all persistence calls these target registration cases exercise.
    const store = new SshConnectionStore(persisted as never)
    const target = store.upsertEnvironmentProviderTarget(owner, endpoint)
    persisted.updateSshTarget(target.id, {
      orcadFence: { environmentId: 'server-one' },
      lastRequiredPassphrase: true
    })
    const updated = store.upsertEnvironmentProviderTarget(
      { ...owner, resourceRevision: 'r2' },
      endpoint
    )
    expect(updated.generation).toBe(target.generation)
    expect(updated.orcadFence).toEqual({ environmentId: 'server-one' })
    expect(updated.lastRequiredPassphrase).toBe(true)
  })
  it('encounters an earlier source owner at the stable resource ID rather than creating a parallel target', () => {
    const persisted = createMockStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements all persistence calls these target registration cases exercise.
    const store = new SshConnectionStore(persisted as never)
    const first = store.upsertEnvironmentProviderTarget(owner, endpoint)
    expect(() =>
      store.upsertEnvironmentProviderTarget(
        { ...owner, binding: { ...owner.binding, sourceDigest: 'c'.repeat(64) } },
        endpoint
      )
    ).toThrow('another environment owner')
    expect(store.listTargets()).toHaveLength(1)
    expect(store.getTarget(first.id)?.environmentProvider).toEqual(owner)
  })
})
