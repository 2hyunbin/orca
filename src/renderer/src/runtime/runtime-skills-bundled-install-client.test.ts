import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
const runtimeEnvironmentSupportsCapability = vi.fn()

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args),
  runtimeEnvironmentSupportsCapability: (...args: unknown[]) =>
    runtimeEnvironmentSupportsCapability(...args),
  assertRuntimeEnvironmentCapability: vi.fn()
}))

const { installBundledOrcaSkillsOnRuntimeTarget } = await import('./runtime-skills-client')

const installBundledOrca = vi.fn()
const bundledOrcaInstallSupported = vi.fn()
const REMOTE = { kind: 'environment', environmentId: 'env-1' } as const

beforeEach(() => {
  vi.clearAllMocks()
  bundledOrcaInstallSupported.mockResolvedValue(true)
  installBundledOrca.mockResolvedValue([])
  vi.stubGlobal('window', { api: { skills: { installBundledOrca, bundledOrcaInstallSupported } } })
})

describe('installBundledOrcaSkillsOnRuntimeTarget', () => {
  it('installs on this machine, into the requested WSL distro, through the preload', async () => {
    const request = { names: ['orca-cli'], wsl: { distro: 'Ubuntu' } }

    expect(await installBundledOrcaSkillsOnRuntimeTarget({ kind: 'local' }, request)).toEqual({
      kind: 'installed',
      results: []
    })
    expect(installBundledOrca).toHaveBeenCalledWith(request)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('reports unsupported when the web "local" host predates the installer', async () => {
    bundledOrcaInstallSupported.mockResolvedValue(false)

    expect(
      await installBundledOrcaSkillsOnRuntimeTarget({ kind: 'local' }, { names: ['orca-cli'] })
    ).toEqual({ kind: 'unsupported' })
    expect(installBundledOrca).not.toHaveBeenCalled()
  })

  it('installs on a focused server without forwarding this client WSL distro', async () => {
    runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    callRuntimeRpc.mockResolvedValue([])

    await installBundledOrcaSkillsOnRuntimeTarget(REMOTE, {
      names: ['orchestration'],
      wsl: { distro: 'Ubuntu' }
    })

    expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      'env-1',
      'skills.install.bundled-orca.v1'
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      REMOTE,
      'skills.installBundledOrca',
      { names: ['orchestration'] },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
  })

  it('issues no RPC to a server that predates the installer', async () => {
    runtimeEnvironmentSupportsCapability.mockResolvedValue(false)

    expect(
      await installBundledOrcaSkillsOnRuntimeTarget(REMOTE, { names: ['orchestration'] })
    ).toEqual({ kind: 'unsupported' })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
