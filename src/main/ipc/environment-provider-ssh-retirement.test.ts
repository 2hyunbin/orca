import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
const mocks = vi.hoisted(() => ({
  targets: new Map<string, SshTarget>(),
  invalidate: vi.fn(),
  clear: vi.fn(),
  close: vi.fn(async () => {}),
  teardown: vi.fn(async () => {})
}))
vi.mock('../ssh/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({
    getTarget: (id: string) => mocks.targets.get(id),
    listTargets: () => [...mocks.targets.values()]
  })
}))
vi.mock('../ssh/orcad-managed-tunnel', () => ({ closeOrcadManagedTunnel: mocks.close }))
vi.mock('../ssh/ssh-host-server-status', () => ({ clearSshHostServerStatus: mocks.clear }))
vi.mock('./ssh-connect-attempt-registry', () => ({ invalidateConnectAttempt: mocks.invalidate }))
vi.mock('./ssh-session-teardown', () => ({ teardownSshTargetTransport: mocks.teardown }))
import {
  retireEnvironmentProviderConnections,
  retireEnvironmentProviderSshTarget,
  watchEnvironmentProviderSshLease
} from './environment-provider-ssh-retirement'
function target(id = 'provider-ssh-one'): SshTarget {
  return {
    id,
    generation: 1,
    label: 'Devbox',
    host: 'box.internal',
    port: 22,
    username: 'developer',
    orcadFence: { environmentId: 'server-one' },
    environmentProvider: {
      version: 1,
      binding: {
        executionHostId: 'local',
        providerId: 'company.platform/pods',
        contextId: 'company/account',
        sourceDigest: 'a'.repeat(64),
        recipeDigest: 'b'.repeat(64)
      },
      resourceId: 'devbox',
      resourceRevision: 'r1',
      connection: {
        type: 'ssh',
        host: 'box.internal',
        port: 22,
        username: 'developer',
        projectRoot: '/projects'
      }
    }
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.targets.clear()
})
describe('owned provider connection retirement', () => {
  it('closes its managed tunnel and SSH session without removing saved records or unrelated targets', async () => {
    const owned = target()
    const other = { ...target('other'), environmentProvider: undefined }
    mocks.targets.set(owned.id, owned)
    mocks.targets.set(other.id, other)
    await retireEnvironmentProviderConnections('company.platform/pods')
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(owned.id)
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith('server-one')
    expect(mocks.teardown).toHaveBeenCalledExactlyOnceWith(owned.id)
    expect(mocks.targets.get(owned.id)).toEqual(owned)
    expect(mocks.targets.get(other.id)).toEqual(other)
  })
  it('does not retire a replacement registration while waiting for prior target cleanup', async () => {
    const original = target()
    mocks.targets.set(original.id, original)
    const held = Promise.withResolvers<void>()
    const prior = runTargetLifecycle(original.id, () => held.promise)
    const retire = retireEnvironmentProviderSshTarget(original)
    mocks.targets.set(original.id, { ...original, generation: 2 })
    held.resolve()
    await Promise.all([prior, retire])
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.teardown).not.toHaveBeenCalled()
  })
  it('refuses a withdrawn review owner even when the target ID and generation are unchanged', async () => {
    const original = target()
    mocks.targets.set(original.id, {
      ...original,
      environmentProvider: { ...original.environmentProvider!, resourceRevision: 'r2' }
    })
    await retireEnvironmentProviderSshTarget(original)
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('registers one revocation cleanup for repeated admission of the same saved machine', async () => {
    const owned = target()
    mocks.targets.set(owned.id, owned)
    const controller = new AbortController()
    const lease = { signal: controller.signal, isCurrent: () => true }
    watchEnvironmentProviderSshLease(owned, lease)
    watchEnvironmentProviderSshLease(owned, lease)
    controller.abort()
    await vi.waitFor(() => expect(mocks.teardown).toHaveBeenCalledOnce())
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it('refuses to report successful retirement when the managed tunnel could not be closed', async () => {
    const owned = target()
    mocks.targets.set(owned.id, owned)
    mocks.close.mockRejectedValueOnce(new Error('owned tunnel close failed'))
    await expect(retireEnvironmentProviderConnections('company.platform/pods')).rejects.toThrow(
      'could not be retired'
    )
    expect(mocks.targets.get(owned.id)).toEqual(owned)
  })
})
