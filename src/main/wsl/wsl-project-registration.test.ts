import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(async (_distro: string) => 'wsl:ubuntu'),
  call: vi.fn(),
  enabled: true,
  serviceAvailable: true
}))
vi.mock('./wsl-host-service-instance', () => ({
  getWslHostService: () => mocks.serviceAvailable
    ? { isEnabled: () => mocks.enabled, ensure: mocks.ensure, callProject: mocks.call }
    : null
}))
import { assertWslProjectRoutingCaller, registerProjectOnWslHost } from './wsl-project-registration'
import { importNestedProjectsOnWslHost } from './wsl-nested-project-import'

const guest: Repo = {
  id: 'guest-repo', path: '/home/me/repo', displayName: 'repo', kind: 'git',
  badgeColor: 'blue', addedAt: 1
}
const originalPlatform = process.platform

describe('new WSL project ownership', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
    mocks.enabled = true
    mocks.serviceAvailable = true
    mocks.ensure.mockReset().mockResolvedValue('wsl:ubuntu')
    mocks.call.mockReset().mockResolvedValue({ repo: guest })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    vi.unstubAllEnvs()
  })

  it('waits for the guest then uses the existing Add, folder, clone and create contracts', async () => {
    const store = { getRepos: () => [] }
    let ready!: (environmentId: string) => void
    mocks.ensure.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve }))
    const adding = registerProjectOnWslHost(store, {
      kind: 'add', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    })
    expect(mocks.call).not.toHaveBeenCalled()
    ready('wsl:ubuntu')
    await expect(adding).resolves.toMatchObject({
      id: guest.id, path: guest.path, executionHostId: 'runtime:wsl:ubuntu'
    })
    await registerProjectOnWslHost(store, {
      kind: 'add', path: '\\\\wsl$\\Ubuntu\\home\\me\\notes', repoKind: 'folder'
    })
    await registerProjectOnWslHost(store, {
      kind: 'clone', path: '\\\\wsl$\\Ubuntu\\home\\me', url: 'https://example.com/repo.git'
    })
    await registerProjectOnWslHost(store, {
      kind: 'create', path: '\\\\wsl$\\Ubuntu\\home\\me', name: 'repo', repoKind: 'git'
    })
    expect(mocks.call.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ['wsl:ubuntu', 'repo.add', { path: '/home/me/repo', kind: undefined, displayName: undefined }],
      ['wsl:ubuntu', 'repo.add', { path: '/home/me/notes', kind: 'folder', displayName: undefined }],
      ['wsl:ubuntu', 'repo.clone', { destination: '/home/me', url: 'https://example.com/repo.git' }],
      ['wsl:ubuntu', 'repo.create', { parentPath: '/home/me', name: 'repo', kind: 'git' }]
    ])
  })

  it('preserves existing local rows across UNC aliases and leaves other owners and drive paths alone', async () => {
    const existing = { ...guest, path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' }
    const store = { getRepos: () => [existing] }
    await expect(registerProjectOnWslHost(store, {
      kind: 'add', path: '\\\\wsl$\\ubuntu\\home\\me\\repo\\'
    })).resolves.toBe(existing)
    await expect(registerProjectOnWslHost(store, {
      kind: 'clone', path: '\\\\wsl$\\ubuntu\\home\\me', url: 'https://example.com/repo.git'
    })).resolves.toBe(existing)
    await expect(registerProjectOnWslHost(store, {
      kind: 'add', path: 'C:\\work\\repo'
    })).resolves.toBeNull()
    await expect(registerProjectOnWslHost(store, {
      kind: 'add', path: existing.path
    }, 'runtime:other-host')).resolves.toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('honors both gates and reports host setup failures without creating a Windows fallback', async () => {
    const operation = { kind: 'add' as const, path: '\\\\wsl$\\Ubuntu\\home\\me\\repo' }
    const store = { getRepos: () => [] }
    mocks.enabled = false
    await expect(registerProjectOnWslHost(store, operation)).resolves.toBeNull()
    mocks.enabled = true
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '0')
    await expect(registerProjectOnWslHost(store, operation)).resolves.toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
    mocks.ensure.mockRejectedValueOnce(new Error('server install failed'))
    await expect(registerProjectOnWslHost(store, operation)).rejects.toThrow('server install failed')
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('refuses a new headless UNC add when both gates are on, without changing saved rows', async () => {
    mocks.serviceAvailable = false
    const saved = { ...guest, path: '\\\\wsl$\\Ubuntu\\home\\me\\old' }
    const store = { getRepos: () => [saved], getSettings: () => ({ experimentalWslHosts: true }) }
    await expect(registerProjectOnWslHost(store, { kind: 'add', path: saved.path })).resolves.toBe(saved)
    const operation = { kind: 'add' as const, path: '\\\\wsl$\\Ubuntu\\home\\me\\new' }
    await expect(registerProjectOnWslHost(store, operation)).rejects.toThrow('desktop app')
    await expect(registerProjectOnWslHost(
      { ...store, getSettings: () => ({ experimentalWslHosts: false }) }, operation
    )).resolves.toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('imports new nested projects on the guest while retaining saved Windows-owned rows', async () => {
    const saved = { ...guest, path: '\\\\wsl$\\Ubuntu\\home\\me\\old' }
    mocks.call.mockResolvedValueOnce({
      projects: [{ path: '/home/me/new', projectId: 'new', status: 'imported' }],
      importedCount: 1, alreadyKnownCount: 0, failedCount: 0
    })
    const result = await importNestedProjectsOnWslHost({ getRepos: () => [saved] }, {
      parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\me', mode: 'separate',
      projectPaths: [saved.path, '\\\\wsl$\\Ubuntu\\home\\me\\new']
    })
    expect(mocks.call).toHaveBeenCalledWith('wsl:ubuntu', 'projectGroup.importNested', {
      parentPath: '/home/me', mode: 'separate', projectPaths: ['/home/me/new']
    })
    expect(result).toMatchObject({
      executionHostId: 'runtime:wsl:ubuntu', importedCount: 1, alreadyKnownCount: 1,
      projects: [
        { path: saved.path, projectId: saved.id, status: 'already-known' },
        { projectId: 'new', status: 'imported' }
      ]
    })
    expect(() => assertWslProjectRoutingCaller(saved.path, { kind: 'paired-device', deviceId: 'old-client' })).toThrow('Windows desktop')
    expect(() => assertWslProjectRoutingCaller(saved.path, { kind: 'local-cli' })).not.toThrow()
  })

  it('does not deploy a host or create a guest group for an already-known nested selection', async () => {
    const saved = { ...guest, path: '\\\\wsl$\\Ubuntu\\home\\me\\old' }
    const result = await importNestedProjectsOnWslHost({ getRepos: () => [saved] }, {
      parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\me', mode: 'group', projectPaths: [saved.path]
    })
    expect(result).toMatchObject({ importedCount: 0, alreadyKnownCount: 1 })
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
