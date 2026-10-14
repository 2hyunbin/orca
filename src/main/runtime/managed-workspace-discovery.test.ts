import { beforeEach, expect, it, vi } from 'vitest'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import { MANAGED_RUNTIME_SESSION_CAPABILITY } from '../../shared/managed-runtime-session-contract'
import { RUNTIME_PROTOCOL_VERSION } from '../../shared/protocol-version'
import { discoverManagedWorkspace } from './managed-workspace-discovery'
const state = vi.hoisted(() => ({
  environment: vi.fn(),
  target: vi.fn(),
  admit: vi.fn(),
  prepare: vi.fn(),
  request: vi.fn(),
  mark: vi.fn(),
  retire: vi.fn()
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: state.environment,
  markEnvironmentUsed: state.mark
}))
vi.mock('../ssh/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ getTarget: state.target })
}))
vi.mock('../ssh/environment-provider-ssh-admission', () => ({
  admitEnvironmentProviderSshTarget: state.admit
}))
vi.mock('../ipc/runtime-environment-connection-lease', () => ({
  prepareRuntimeEnvironmentConnectionLease: state.prepare
}))
vi.mock('../ipc/runtime-environment-transport-generation', () => ({
  advanceRuntimeEnvironmentTransportGeneration: state.retire
}))
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: state.request }))
let environment: KnownRuntimeEnvironment
let target: SshTarget
let provider: AbortController
const close = vi.fn()
const pairing = {
  endpoint: 'ws://127.0.0.1:8000',
  hostPublicKeyB64: 'child-key',
  credential: { kind: 'token' as const, deviceToken: 'private-child-token' }
}
beforeEach(() => {
  vi.clearAllMocks()
  provider = new AbortController()
  environment = {
    ...createEnvironmentFromPairingOffer({
      id: 'managed',
      name: 'Devbox',
      now: 1,
      runtimeId: null,
      connectionDependency: 'ssh-tunnel',
      offer: {
        v: 2,
        endpoint: 'ws://127.0.0.1:8000',
        deviceToken: 'private-child-token',
        publicKeyB64: 'child-key'
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
    username: 'dev',
    generation: 1,
    orcadFence: { environmentId: 'managed' }
  }
  state.environment.mockImplementation(() => environment)
  state.target.mockImplementation(() => target)
  state.admit.mockResolvedValue({
    signal: provider.signal,
    isCurrent: () => !provider.signal.aborted
  })
  state.prepare.mockResolvedValue({ pairing, isCurrent: () => true, close })
  state.request.mockResolvedValue({
    ok: true,
    _meta: { runtimeId: 'child-process' },
    result: {
      runtimeId: 'child-process',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: 0,
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      deviceScope: 'runtime',
      capabilities: [MANAGED_RUNTIME_SESSION_CAPABILITY]
    }
  })
  state.mark.mockImplementation((_path, _id, args) => {
    environment = { ...environment, runtimeId: args.runtimeId }
  })
})
it('learns an unconfirmed live child through its saved pairing and returns no credentials', async () => {
  const descriptor = await discoverManagedWorkspace(
    'profile',
    { sshTargetId: 'ssh', targetGeneration: 1 },
    'controller-process'
  )
  expect(descriptor).toMatchObject({
    environmentId: 'managed',
    runtimeId: 'child-process',
    controllerRuntimeId: 'controller-process'
  })
  expect(JSON.stringify(descriptor)).not.toContain('private-child-token')
  expect(state.mark).toHaveBeenCalledWith('profile', 'managed', {
    runtimeId: 'child-process',
    pairingDeviceToken: 'private-child-token'
  })
  expect(state.retire).toHaveBeenCalledExactlyOnceWith('managed')
  expect(close).toHaveBeenCalledTimes(1)
})
it('refuses stale registration before any child contact', async () => {
  target = { ...target, generation: 2 }
  await expect(
    discoverManagedWorkspace('profile', { sshTargetId: 'ssh', targetGeneration: 1 }, 'controller')
  ).rejects.toThrow('target changed')
  expect(state.request).not.toHaveBeenCalled()
  expect(state.prepare).not.toHaveBeenCalled()
})
it('rechecks provider withdrawal after the asynchronous identity probe', async () => {
  state.request.mockImplementation(async () => {
    provider.abort()
    return { ok: true, _meta: { runtimeId: 'child' }, result: {} }
  })
  await expect(
    discoverManagedWorkspace('profile', { sshTargetId: 'ssh', targetGeneration: 1 }, 'controller')
  ).rejects.toThrow()
  expect(state.mark).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledTimes(1)
})
it('refuses a response whose envelope names another runtime', async () => {
  const previous = await state.request()
  state.request.mockResolvedValue({ ...previous, _meta: { runtimeId: 'foreign' } })
  await expect(
    discoverManagedWorkspace('profile', { sshTargetId: 'ssh', targetGeneration: 1 }, 'controller')
  ).rejects.toThrow('invalid identity')
  expect(state.mark).not.toHaveBeenCalled()
})
