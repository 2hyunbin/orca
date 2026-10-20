import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(async (_distro: string) => 'wsl:ubuntu'),
  call: vi.fn(),
  ownerRepos: [] as Repo[],
  setupMethod: 'legacy-repo',
  target: (path: string) => path,
  enabled: true,
  serviceAvailable: true
}))
vi.mock('./wsl-host-service-instance', () => ({
  getWslHostService: () => mocks.serviceAvailable
    ? { isEnabled: () => mocks.enabled, ensure: mocks.ensure, callProject: mocks.call }
    : null
}))
vi.mock('../git/runner', () => ({ awaitWindowsHostGitEnvironmentReady: vi.fn(async () => {}) }))
vi.mock('../git/repo', () => ({
  inspectGitRepoForRegistrationAsync: vi.fn(async (path: string) => ({ isRepo: true, rootPath: mocks.target(path) })),
  getGitRepoRootAsync: vi.fn(async (path: string) => path)
}))
vi.mock('../project-groups/nested-repo-import-target', () => ({
  createNestedRepoImportTargetResolver: () => ({ resolveLocal: async (path: string) => mocks.target(path) })
}))
import { setupProjectOnWslHost } from './wsl-project-host-setup'
import { registerProjectOnWslHost } from './wsl-project-registration'
import type { NestedRepoScanResult } from '../../shared/project-group-types'
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
function scan(projectPaths: string[]): NestedRepoScanResult {
  return { selectedPath: '\\\\wsl$\\Ubuntu\\home\\me', selectedPathKind: 'non_git_folder',
    repos: projectPaths.map((path) => ({ path, displayName: 'repo', depth: 1 })),
    truncated: false, timedOut: false, stopped: false, durationMs: 1, maxDepth: 5, maxRepos: 100, timeoutMs: 15000 }
}
const originalPlatform = process.platform

describe('new WSL project ownership', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
    mocks.enabled = true
    mocks.serviceAvailable = true
    mocks.ensure.mockReset().mockResolvedValue('wsl:ubuntu')
    mocks.ownerRepos = []
    mocks.setupMethod = 'legacy-repo'
    mocks.target = (path) => path
    mocks.call.mockReset().mockImplementation(async (_env, method, params) => {
      if (method === 'repo.list') return { repos: [...mocks.ownerRepos] }
      if (method === 'projectHostSetup.list') return { setups: mocks.ownerRepos.map((repo) => ({
        projectId: 'owner-project', repoId: repo.id, path: repo.path, hostId: 'local', setupMethod: mocks.setupMethod
      })) }
      if (method === 'project.list') return { projects: [{ id: 'owner-project' }] }
      if (method === 'projectHostSetup.setupExistingFolder') return { result: { repo: mocks.ownerRepos[0] } }
      const path = method === 'repo.create' ? `${params.parentPath}/${params.name}` : params.path
      const repo = mocks.ownerRepos.find((row) => row.path === path) ?? { ...guest, path }
      mocks.ownerRepos.push(repo)
      return { repo }
    })
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
    await vi.waitFor(() => expect(mocks.ensure).toHaveBeenCalled())
    ready('wsl:ubuntu')
    await expect(adding).resolves.toMatchObject({
      id: guest.id,
      path: guest.path,
      executionHostId: 'runtime:wsl%3Aubuntu'
    })
    expect(mocks.call).toHaveBeenCalledWith('wsl:ubuntu', 'projectHostSetup.setupExistingFolder', {
      projectId: 'owner-project', hostId: 'local', path: guest.path,
      kind: 'git', setupMethod: 'imported-existing-folder'
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
    expect(mocks.call.mock.calls.filter(([, method]) => method === 'repo.add' || method === 'repo.create')).toEqual([
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
    const result = await importNestedProjectsOnWslHost(
      { getRepos: () => [saved] },
      {
        parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\me',
        mode: 'separate',
        projectPaths: ['\\\\wsl$\\Ubuntu\\home\\me\\new', saved.path]
      },
      { scan: scan(['\\\\wsl$\\Ubuntu\\home\\me\\new', saved.path]) }
    )
    expect(mocks.call).toHaveBeenCalledWith('wsl:ubuntu', 'repo.add', expect.objectContaining({ path: '/home/me/new' }))
    expect(result).toMatchObject({
      importedCount: 1,
      alreadyKnownCount: 1,
      projects: [
        { projectId: guest.id, status: 'imported', executionHostId: 'runtime:wsl%3Aubuntu' },
        { path: saved.path, projectId: saved.id, status: 'already-known', executionHostId: 'local' }
      ]
    })
  })

  it('leaves an all-saved selection to the local import and refuses a mixed group before any work', async () => {
    const store = { getRepos: () => [saved] }
    const parentPath = '\\\\wsl.localhost\\Ubuntu\\home\\me'
    const linked = parentPath + '\\topic'
    mocks.target = (path) => path === linked ? saved.path : path
    await expect(importNestedProjectsOnWslHost(store, { parentPath, mode: 'group',
      projectPaths: [linked] }, { scan: scan([linked]) })).resolves.toBeNull()
    await expect(
      importNestedProjectsOnWslHost(store, { parentPath, mode: 'group', projectPaths: [saved.path] }, { scan: scan([saved.path]) })
    ).resolves.toBeNull()
    await expect(
      importNestedProjectsOnWslHost(store, {
        parentPath,
        mode: 'group',
        projectPaths: [saved.path, '\\\\wsl$\\Ubuntu\\home\\me\\new']
      }, { scan: scan([saved.path, '\\\\wsl$\\Ubuntu\\home\\me\\new']) })
    ).rejects.toThrow('Import them separately')
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })
  it('keeps a canonical Windows claim before paired refusal and preserves concurrent cloned provenance', async () => {
    const child = saved.path + '\\packages\\web'
    mocks.target = (path) => path === child ? saved.path : path
    await expect(registerProjectOnWslHost({ getRepos: () => [saved] }, { kind: 'add', path: child },
      { fromPairedClient: true })).resolves.toBe(saved)
    await expect(setupProjectOnWslHost({ getRepos: () => [saved] },
      { projectId: 'owner-project', hostId: 'local', path: child }, { fromPairedClient: true })).resolves.toBeNull()
    expect(mocks.ensure).not.toHaveBeenCalled()
    mocks.setupMethod = 'cloned'
    await registerProjectOnWslHost({ getRepos: () => [] }, { kind: 'add', path: child })
    expect(mocks.call).toHaveBeenCalledWith('wsl:ubuntu', 'repo.add', expect.objectContaining({ path: '/home/me/old' }))
    expect(mocks.call.mock.calls.some(([, method]) => method === 'projectHostSetup.setupExistingFolder')).toBe(false)
  })

  it('validates every original selection and retains a row when grouping returns a different checkout', async () => {
    const linked = '\\\\wsl$\\Ubuntu\\home\\me\\topic'
    const outside = '\\\\wsl$\\Ubuntu\\elsewhere\\repo'
    mocks.target = (path) => path === linked ? outside : path
    const normal = mocks.call.getMockImplementation()
    if (!normal) throw new Error('fixture requires an owner implementation')
    mocks.call.mockImplementation(async (env, method, params) => method === 'projectGroup.importNested'
      ? { projects: [{ path: '/home/me/topic', projectId: 'changed-graph-row', status: 'imported' }], importedCount: 1, alreadyKnownCount: 0, failedCount: 0 }
      : normal(env, method, params))
    const result = await importNestedProjectsOnWslHost({ getRepos: () => [saved] }, {
      parentPath: scan([]).selectedPath, projectPaths: [linked, saved.path], mode: 'group'
    }, { scan: scan([linked]) })
    expect(mocks.call).toHaveBeenCalledWith('wsl:ubuntu', 'repo.add', expect.objectContaining({ path: '/elsewhere/repo' }))
    expect(mocks.call).toHaveBeenCalledWith('wsl:ubuntu', 'projectGroup.importNested', expect.objectContaining({ projectPaths: ['/home/me/topic'], groupName: 'me' }))
    expect(result).toMatchObject({ failedCount: 2, importedCount: 0, projects: [
      { path: linked, projectId: 'changed-graph-row', status: 'failed' }, { path: saved.path, status: 'failed' }
    ] })
    expect(mocks.ownerRepos[0].path).toBe('/elsewhere/repo')
  })

  it('returns a failed nested item with its saved owner row when setup fails after Add', async () => {
    const path = '\\\\wsl$\\Ubuntu\\home\\me\\repo'
    const normal = mocks.call.getMockImplementation()
    if (!normal) throw new Error('fixture requires an owner implementation')
    mocks.call.mockImplementation(async (env, method, params) => {
      if (method === 'projectHostSetup.setupExistingFolder') throw new Error('setup failed')
      return normal(env, method, params)
    })
    const result = await importNestedProjectsOnWslHost({ getRepos: () => [] }, {
      parentPath: scan([]).selectedPath, projectPaths: [path], mode: 'separate'
    }, { scan: scan([path]) })
    expect(result).toMatchObject({ importedCount: 0, failedCount: 1, projects: [
      { path, projectId: guest.id, executionHostId: 'runtime:wsl%3Aubuntu', status: 'failed', error: 'setup failed' }
    ] })
    expect(mocks.ownerRepos).toHaveLength(1)
  })

})
