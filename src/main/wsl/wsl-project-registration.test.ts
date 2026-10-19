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
import { registerProjectOnWslHost } from './wsl-project-registration'
import { importNestedProjectsOnWslHost } from './wsl-nested-project-import'

const guest: Repo = {
  id: 'guest-repo',
  path: '/home/me/repo',
  displayName: 'repo',
  kind: 'git',
  badgeColor: 'blue',
  addedAt: 1
}
const saved: Repo = { ...guest, id: 'saved-repo', path: '\\\\wsl$\\Ubuntu\\home\\me\\old' }
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

  it('waits for the guest then uses the existing Add, folder and create contracts', async () => {
    const store = { getRepos: () => [] }
    let ready!: (environmentId: string) => void
    mocks.ensure.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve
        })
    )
    const adding = registerProjectOnWslHost(store, {
      kind: 'add',
      path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    })
    expect(mocks.call).not.toHaveBeenCalled()
    ready('wsl:ubuntu')
    await expect(adding).resolves.toMatchObject({
      id: guest.id,
      path: guest.path,
      executionHostId: 'runtime:wsl%3Aubuntu'
    })
    await registerProjectOnWslHost(store, {
      kind: 'add',
      path: '\\\\wsl$\\Ubuntu\\home\\me\\notes',
      repoKind: 'folder'
    })
    await registerProjectOnWslHost(store, {
      kind: 'create',
      path: '\\\\wsl$\\Ubuntu\\home\\me',
      name: 'repo',
      repoKind: 'git'
    })
    expect(mocks.call.mock.calls).toEqual([
      ['wsl:ubuntu', 'repo.add', { path: '/home/me/repo', kind: undefined, displayName: undefined }],
      ['wsl:ubuntu', 'repo.add', { path: '/home/me/notes', kind: 'folder', displayName: undefined }],
      ['wsl:ubuntu', 'repo.create', { parentPath: '/home/me', name: 'repo', kind: 'git' }]
    ])
  })

  it('keeps saved Windows rows across UNC aliases and leaves other owners and drive paths alone', async () => {
    const store = { getRepos: () => [saved] }
    await expect(
      registerProjectOnWslHost(store, { kind: 'add', path: '\\\\wsl.localhost\\ubuntu\\home\\me\\old\\' })
    ).resolves.toBe(saved)
    await expect(
      registerProjectOnWslHost(store, { kind: 'add', path: 'C:\\work\\repo' })
    ).resolves.toBeNull()
    await expect(
      registerProjectOnWslHost(
        store,
        { kind: 'add', path: '\\\\wsl$\\Ubuntu\\home\\me\\new' },
        { executionHostId: 'runtime:other-host' }
      )
    ).resolves.toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('refuses a paired client only when a new WSL project would be created', async () => {
    const store = { getRepos: () => [saved] }
    const paired = { fromPairedClient: true }
    await expect(
      registerProjectOnWslHost(store, { kind: 'add', path: saved.path }, paired)
    ).resolves.toBe(saved)
    await expect(
      registerProjectOnWslHost(store, { kind: 'add', path: '\\\\wsl$\\Ubuntu\\home\\me\\new' }, paired)
    ).rejects.toThrow('Windows desktop')
    expect(mocks.ensure).not.toHaveBeenCalled()
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
    const store = { getRepos: () => [saved], getSettings: () => ({ experimentalWslHosts: true }) }
    await expect(registerProjectOnWslHost(store, { kind: 'add', path: saved.path })).resolves.toBe(
      saved
    )
    const operation = { kind: 'add' as const, path: '\\\\wsl$\\Ubuntu\\home\\me\\new' }
    await expect(registerProjectOnWslHost(store, operation)).rejects.toThrow('desktop app')
    await expect(
      registerProjectOnWslHost(
        { ...store, getSettings: () => ({ experimentalWslHosts: false }) },
        operation
      )
    ).resolves.toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('imports new nested projects on the guest in selection order, each row keeping its owner', async () => {
    mocks.call.mockResolvedValueOnce({
      projects: [{ path: '/home/me/new', projectId: 'new', status: 'imported' }],
      importedCount: 1,
      alreadyKnownCount: 0,
      failedCount: 0
    })
    const result = await importNestedProjectsOnWslHost(
      { getRepos: () => [saved] },
      {
        parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\me',
        mode: 'separate',
        projectPaths: ['\\\\wsl$\\Ubuntu\\home\\me\\new', saved.path]
      }
    )
    expect(mocks.call).toHaveBeenCalledWith('wsl:ubuntu', 'projectGroup.importNested', {
      parentPath: '/home/me',
      mode: 'separate',
      projectPaths: ['/home/me/new']
    })
    expect(result).toMatchObject({
      importedCount: 1,
      alreadyKnownCount: 1,
      projects: [
        { projectId: 'new', status: 'imported', executionHostId: 'runtime:wsl%3Aubuntu' },
        { path: saved.path, projectId: saved.id, status: 'already-known', executionHostId: 'local' }
      ]
    })
  })

  it('leaves an all-saved selection to the local import and refuses a mixed group before any work', async () => {
    const store = { getRepos: () => [saved] }
    const parentPath = '\\\\wsl.localhost\\Ubuntu\\home\\me'
    await expect(
      importNestedProjectsOnWslHost(store, { parentPath, mode: 'group', projectPaths: [saved.path] })
    ).resolves.toBeNull()
    await expect(
      importNestedProjectsOnWslHost(store, {
        parentPath,
        mode: 'group',
        projectPaths: [saved.path, '\\\\wsl$\\Ubuntu\\home\\me\\new']
      })
    ).rejects.toThrow('Import them separately')
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
