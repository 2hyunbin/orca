import { beforeEach, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { createManagedWorkspaceHosts } from './managed-workspace-hosts'

const state = vi.hoisted(() => ({
  environment: vi.fn(),
  target: vi.fn(),
  admit: vi.fn(),
  prepare: vi.fn()
}))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: state.environment }))
vi.mock('../ssh/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ getTarget: state.target })
}))
vi.mock('../ssh/environment-provider-ssh-admission', () => ({
  admitEnvironmentProviderSshTarget: state.admit
}))
vi.mock('../ipc/runtime-environment-connection-lease', () => ({
  prepareRuntimeEnvironmentConnectionLease: state.prepare
}))
let environment: KnownRuntimeEnvironment
let target: SshTarget
let provider: AbortController
const connection = {
  endpoint: 'ws://127.0.0.1:8000',
  hostPublicKeyB64: 'verified-key',
  credential: { kind: 'token' as const, deviceToken: 'private-child-token' }
}
const close = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  provider = new AbortController()
  environment = {
    ...createEnvironmentFromPairingOffer({
      id: 'devbox',
      name: 'Company devbox',
      now: 1,
      runtimeId: 'child',
      connectionDependency: 'ssh-tunnel',
      offer: {
        v: 2,
        endpoint: 'ws://127.0.0.1:8000',
        deviceToken: 'private-child-token',
        publicKeyB64: 'verified-key'
      }
    }),
    orcadDeployment: {
      sshTargetId: 'ssh',
      sshTargetGeneration: 1,
      localPort: 8000,
      remotePort: 9000
    }
  }
  target = {
    id: 'ssh',
    label: 'Devbox',
    host: 'private.internal',
    port: 22,
    username: 'developer',
    generation: 1,
    orcadFence: { environmentId: 'devbox' }
  }
  state.environment.mockImplementation(() => environment)
  state.target.mockImplementation(() => target)
  state.admit.mockResolvedValue({
    signal: provider.signal,
    isCurrent: () => !provider.signal.aborted
  })
  state.prepare.mockResolvedValue({ pairing: connection, isCurrent: () => true, close })
})
const route = { kind: 'managed' as const, environmentId: 'devbox', targetGeneration: 1 }

it('resolves only saved managed ownership and installs current provider admission', async () => {
  const hosts = createManagedWorkspaceHosts('owned-profile')
  const host = await hosts.resolve(route)
  expect(state.admit).toHaveBeenCalledExactlyOnceWith(target)
  expect(state.prepare).toHaveBeenCalledWith(
    'owned-profile',
    { environmentId: 'devbox', pairingRevision: 1, runtimeId: 'child' },
    expect.any(Function),
    provider.signal
  )
  expect(host.connection).toBe(connection)
  expect(host.isCurrent()).toBe(true)
  host.close?.()
  expect(close).toHaveBeenCalledTimes(1)
})
it.each(['generation', 'fence', 'unconfirmed', 'deployment'])(
  'refuses %s before connection preparation',
  async (kind) => {
    if (kind === 'generation') {
      target = { ...target, generation: 2 }
    }
    if (kind === 'fence') {
      target = { ...target, orcadFence: { environmentId: 'other' } }
    }
    if (kind === 'unconfirmed') {
      environment = { ...environment, runtimeId: null }
    }
    if (kind === 'deployment') {
      environment = { ...environment, orcadDeployment: undefined }
    }
    await expect(createManagedWorkspaceHosts('owned-profile').resolve(route)).rejects.toThrow(
      'identity or target generation'
    )
    expect(state.prepare).not.toHaveBeenCalled()
    expect(state.admit).not.toHaveBeenCalled()
  }
)
it('rechecks credentials after awaiting connection preparation and releases its watch', async () => {
  state.prepare.mockImplementation(async () => {
    target = { ...target, identityFile: 'different-key' }
    return { pairing: connection, isCurrent: () => true, close }
  })
  await expect(createManagedWorkspaceHosts('owned-profile').resolve(route)).rejects.toThrow(
    'connection changed'
  )
  expect(close).toHaveBeenCalledTimes(1)
})
it('retires contact on provider withdrawal and removes the watch on close', async () => {
  const hosts = createManagedWorkspaceHosts('owned-profile')
  const retired = vi.fn()
  hosts.onRetired(retired)
  const host = await hosts.resolve(route)
  provider.abort()
  expect(retired).toHaveBeenCalledExactlyOnceWith('devbox')
  expect(host.isCurrent()).toBe(false)
  host.close?.()
})
it('withdraws the lease when saved registration or reconciliation changes', async () => {
  const host = await createManagedWorkspaceHosts('owned-profile').resolve(route)
  target = { ...target, username: 'other-user' }
  expect(host.isCurrent()).toBe(false)
  host.close?.()
})
