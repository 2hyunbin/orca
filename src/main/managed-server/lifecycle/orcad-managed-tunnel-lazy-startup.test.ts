import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../../shared/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../../shared/pairing'

const mocks = vi.hoisted(() => {
  const environment: unknown = undefined
  return {
    environment,
    ensureSsh: vi.fn(async () => {}),
    initialize: vi.fn(),
    ensureTunnel: vi.fn(async () => ({})),
    closeEnvironment: vi.fn(async () => {}),
    closeTarget: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    dispose: vi.fn()
  }
})
vi.mock('../../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => mocks.environment
}))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  ensureSshConnectionManager: mocks.ensureSsh
}))
vi.mock('./orcad-managed-tunnel-implementation', () => ({
  initializeManagedOrcadTunnels: mocks.initialize,
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  closeOrcadManagedTunnel: mocks.closeEnvironment,
  closeOrcadManagedTunnelsForTarget: mocks.closeTarget,
  shutdownOrcadManagedTunnels: mocks.shutdown,
  disposeOrcadManagedTunnels: mocks.dispose
}))

const paired = createEnvironmentFromPairingOffer({
  id: 'env-1',
  name: 'Box',
  now: 1,
  offer: {
    v: PAIRING_OFFER_VERSION,
    endpoint: 'ws://127.0.0.1:4000',
    deviceToken: 'token',
    publicKeyB64: 'key'
  },
  connectionDependency: 'ssh-tunnel'
})
const environment = {
  ...paired,
  orcadDeployment: {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 1,
    localPort: 4000,
    remotePort: 5000
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.environment = environment
  mocks.ensureSsh.mockResolvedValue(undefined)
})

describe('managed tunnel first-use boundary', () => {
  it('does not construct a forwarding manager when importing or closing an unused subsystem', async () => {
    const tunnels = await import('./orcad-managed-tunnel')
    await tunnels.closeOrcadManagedTunnel('env-1')
    await tunnels.closeOrcadManagedTunnelsForTarget('ssh-1')
    await tunnels.shutdownOrcadManagedTunnels()
    tunnels.disposeOrcadManagedTunnels()
    expect(mocks.initialize).not.toHaveBeenCalled()
  })

  it('does not load SSH for a paired network server without an SSH dependency', async () => {
    const tunnels = await import('./orcad-managed-tunnel')
    mocks.environment = { ...paired, connectionDependency: 'direct' }
    await tunnels.ensureOrcadManagedTunnel('/profile', 'env-1')
    expect(mocks.ensureSsh).not.toHaveBeenCalled()
    expect(mocks.initialize).not.toHaveBeenCalled()
  })

  it.each(['environment', 'target', 'dispose'] as const)(
    'cancels a first tunnel if %s teardown wins SSH loading',
    async (owner) => {
      const tunnels = await import('./orcad-managed-tunnel')
      const loading = Promise.withResolvers<void>()
      mocks.ensureSsh.mockReturnValueOnce(loading.promise)
      const pending = tunnels.ensureOrcadManagedTunnel('/profile', 'env-1')
      if (owner === 'environment') {
        await tunnels.closeOrcadManagedTunnel('env-1')
      }
      if (owner === 'target') {
        await tunnels.closeOrcadManagedTunnelsForTarget('ssh-1')
      }
      if (owner === 'dispose') {
        tunnels.disposeOrcadManagedTunnels()
      }
      loading.resolve()
      await expect(pending).rejects.toThrow('superseded')
      expect(mocks.ensureTunnel).not.toHaveBeenCalled()
    }
  )

  it('initializes once and forwards concurrent first requests after SSH becomes available', async () => {
    const tunnels = await import('./orcad-managed-tunnel')
    await Promise.all([
      tunnels.ensureOrcadManagedTunnel('/profile', 'env-1'),
      tunnels.ensureOrcadManagedTunnel('/profile', 'env-1')
    ])
    expect(mocks.initialize).toHaveBeenCalledOnce()
    expect(mocks.ensureTunnel).toHaveBeenCalledTimes(2)
  })
})
