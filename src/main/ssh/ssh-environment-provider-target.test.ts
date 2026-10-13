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
  it('requires the exact reviewed saved target before changing a provider endpoint', () => {
    const persisted = createMockStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the persistence calls used by target registration.
    const store = new SshConnectionStore(persisted as never)
    const first = store.upsertEnvironmentProviderTarget(owner, endpoint)
    const reviewed = structuredClone(first)
    const updatedOwner = {
      ...owner,
      resourceRevision: 'r2',
      connection: { ...owner.connection, host: 'replacement.internal', port: 2222 }
    }
    const replacement = { ...endpoint, host: 'replacement.internal', port: 2222 }
    expect(() => store.upsertEnvironmentProviderTarget(updatedOwner, replacement)).toThrow(
      'requires migration'
    )
    persisted.updateSshTarget(first.id, { identityFile: '/keys/changed-after-review' })
    expect(() =>
      store.upsertEnvironmentProviderTarget(updatedOwner, replacement, undefined, reviewed)
    ).toThrow('changed after its endpoint was reviewed')
    expect(store.getTarget(first.id)?.host).toBe(endpoint.host)
    expect(persisted.allocateSshTargetGeneration).toHaveBeenCalledOnce()
  })
  it('keeps target, credentials, workspace and server ownership but retires the old incarnation', () => {
    const persisted = createMockStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the persistence calls used by target registration.
    const store = new SshConnectionStore(persisted as never)
    const first = structuredClone(
      store.upsertEnvironmentProviderTarget(owner, { ...endpoint, identityFile: '/keys/company' })
    )
    persisted.updateSshTarget(first.id, {
      orcadFence: { environmentId: 'server-one' },
      remoteRuntimeResolution: {
        rung: 'legacy',
        glibc: '2.31',
        runtimeSha256: 'a'.repeat(64),
        orcaMajor: 1
      },
      lastRequiredPassphrase: true,
      managedServerUnavailable: { reason: 'old endpoint refused', appVersion: '1.4.0' },
      managedServerMoveOffered: { appVersion: '1.4.0' },
      managedServerUpdateFailure: { reason: 'old endpoint failed', appVersion: '1.4.0' }
    })
    const reviewed = structuredClone(store.getTarget(first.id)!)
    const replacement = { ...endpoint, host: 'replacement.internal' }
    const updatedOwner = {
      ...owner,
      resourceRevision: 'r2',
      connection: { ...owner.connection, host: replacement.host }
    }
    const updated = store.upsertEnvironmentProviderTarget(
      updatedOwner,
      replacement,
      undefined,
      reviewed
    )
    expect(updated.id).toBe(first.id)
    expect(updated.generation).not.toBe(first.generation)
    expect(updated.host).toBe(replacement.host)
    expect(updated.identityFile).toBe('/keys/company')
    expect(updated.orcadFence).toEqual({ environmentId: 'server-one' })
    expect(updated.lastRequiredPassphrase).toBe(true)
    expect(updated.remoteRuntimeResolution).toBeUndefined()
    expect(updated.managedServerUnavailable).toBeUndefined()
    expect(updated.managedServerMoveOffered).toBeUndefined()
    expect(updated.managedServerUpdateFailure).toBeUndefined()
    expect(updated.environmentProvider).toEqual(updatedOwner)
    expect(persisted.reassignments).toEqual([])
    expect(store.lastRepoReadoptions).toEqual([])
    expect(store.listTargets()).toHaveLength(1)
    expect(() =>
      store.upsertEnvironmentProviderTarget(updatedOwner, replacement, undefined, reviewed)
    ).toThrow('changed after')
  })
  it('does not replace an unreviewed source owner even when its saved endpoint was reviewed', () => {
    const persisted = createMockStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the persistence calls used by target registration.
    const store = new SshConnectionStore(persisted as never)
    const first = store.upsertEnvironmentProviderTarget(owner, endpoint)
    expect(() =>
      store.upsertEnvironmentProviderTarget(
        {
          ...owner,
          binding: { ...owner.binding, sourceDigest: 'c'.repeat(64) },
          connection: { ...owner.connection, host: 'replacement.internal' }
        },
        { ...endpoint, host: 'replacement.internal' },
        undefined,
        structuredClone(first)
      )
    ).toThrow('another environment owner')
  })
  it('refuses an endpoint update while managed server provisioning owns the target', () => {
    const persisted = createMockStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the persistence calls used by target registration.
    const store = new SshConnectionStore(persisted as never)
    const first = store.upsertEnvironmentProviderTarget(owner, endpoint)
    persisted.updateSshTarget(first.id, {
      orcadProvisioning: { requestId: 'server-one', name: 'Devbox' }
    })
    const reviewed = structuredClone(store.getTarget(first.id)!)
    expect(() =>
      store.upsertEnvironmentProviderTarget(
        { ...owner, connection: { ...owner.connection, host: 'replacement.internal' } },
        { ...endpoint, host: 'replacement.internal' },
        undefined,
        reviewed
      )
    ).toThrow('still provisioning')
    expect(persisted.allocateSshTargetGeneration).toHaveBeenCalledOnce()
  })
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
