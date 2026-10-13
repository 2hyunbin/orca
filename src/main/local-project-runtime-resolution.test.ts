import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../shared/folder-workspace-types'
import type { Project } from '../shared/project-types'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import type {
  GlobalWindowsRuntimeDefault,
  LocalWindowsRuntimePreference
} from '../shared/project-execution-runtime'
import { resolveLocalProjectRuntimeForWorktreeId } from './local-project-runtime-resolution'

const originalPlatform = process.platform
const repo: Repo = {
  id: 'repo-1',
  path: 'C:\\work\\repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 0,
  projectGroupId: 'group-1'
}
const folder: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'Work',
  folderPath: 'C:\\work',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0
}
const group: ProjectGroup = {
  id: 'group-1',
  name: 'Work',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

function makeStore(
  args: {
    preference?: LocalWindowsRuntimePreference
    global?: GlobalWindowsRuntimeDefault
    repos?: Repo[]
    folder?: FolderWorkspace
    group?: ProjectGroup
  } = {}
) {
  const repos = args.repos ?? [repo]
  const project: Project = {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: 'blue',
    sourceRepoIds: ['repo-1'],
    localWindowsRuntimePreference: args.preference ?? { kind: 'windows-host' },
    createdAt: 0,
    updatedAt: 0
  }
  return {
    getRepo: (id: string) => repos.find((entry) => entry.id === id),
    getRepos: () => repos,
    getProjects: () => [project],
    getSettings: () => ({
      localWindowsRuntimeDefault: args.global ?? { kind: 'wsl' as const, distro: 'Ubuntu' }
    }),
    getFolderWorkspaces: () => [args.folder ?? folder],
    getProjectGroups: () => [args.group ?? group]
  }
}

beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32' }))
afterEach(() => Object.defineProperty(process, 'platform', { value: originalPlatform }))

describe('project ownership of a folder workspace runtime', () => {
  it('leaves non-agent folder callers on their existing host resolution', () => {
    expect(resolveLocalProjectRuntimeForWorktreeId(makeStore(), 'folder:folder-1')).toBeUndefined()
  })
  it('resolves the single local project instead of treating the folder key as a repo id', () => {
    expect(
      resolveLocalProjectRuntimeForWorktreeId(makeStore(), 'folder:folder-1', undefined, {
        agentLaunch: true
      })
    ).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: 'project-1',
        reason: 'project-override',
        cacheKey: 'project-1:windows-host'
      }
    })
  })

  it('leaves the inherited Windows default on the existing folder shell rule', () => {
    expect(
      resolveLocalProjectRuntimeForWorktreeId(
        makeStore({ preference: { kind: 'inherit-global' }, global: { kind: 'windows-host' } }),
        'folder:folder-1',
        undefined,
        { agentLaunch: true }
      )
    ).toBeUndefined()
  })

  it.each([
    { preference: { kind: 'wsl', distro: 'Debian' }, reason: 'project-override' },
    { preference: { kind: 'inherit-global' }, reason: 'global-default' }
  ] as const)('resolves the folder WSL runtime from $reason', ({ preference, reason }) => {
    expect(
      resolveLocalProjectRuntimeForWorktreeId(
        makeStore({ preference, global: { kind: 'wsl', distro: 'Debian' } }),
        'folder:folder-1',
        undefined,
        { agentLaunch: true }
      )
    ).toMatchObject({ status: 'resolved', runtime: { kind: 'wsl', distro: 'Debian', reason } })
  })

  it.each([{ executionHostId: 'ssh:target-1' }, { executionHostId: 'runtime:server-1' }] as const)(
    'does not borrow a project across folder host $executionHostId',
    (host) => {
      expect(
        resolveLocalProjectRuntimeForWorktreeId(
          makeStore({ folder: { ...folder, ...host } }),
          'folder:folder-1',
          undefined,
          { agentLaunch: true }
        )
      ).toBeUndefined()
    }
  )

  it('does not borrow the local project from a group pinned to another runtime', () => {
    expect(
      resolveLocalProjectRuntimeForWorktreeId(
        makeStore({ group: { ...group, executionHostId: 'runtime:server-1' } }),
        'folder:folder-1',
        undefined,
        { agentLaunch: true }
      )
    ).toBeUndefined()
  })

  it('does not choose a project from several candidate repos', () => {
    expect(
      resolveLocalProjectRuntimeForWorktreeId(
        makeStore({ repos: [repo, { ...repo, id: 'repo-2', path: 'C:\\work\\other' }] }),
        'folder:folder-1',
        undefined,
        { agentLaunch: true }
      )
    ).toBeUndefined()
  })

  it('leaves repo-less folders on their existing shell rule', () => {
    expect(
      resolveLocalProjectRuntimeForWorktreeId(
        makeStore({ repos: [] }),
        'folder:folder-1',
        undefined,
        { agentLaunch: true }
      )
    ).toBeUndefined()
  })

  it('leaves WSL-share paths owned by their distro', () => {
    expect(
      resolveLocalProjectRuntimeForWorktreeId(
        makeStore({ folder: { ...folder, folderPath: '\\\\wsl$\\Ubuntu\\work' } }),
        'folder:folder-1',
        undefined,
        { agentLaunch: true }
      )
    ).toBeUndefined()
  })

  it('leaves non-Windows folder routing unchanged', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(
      resolveLocalProjectRuntimeForWorktreeId(makeStore(), 'folder:folder-1', undefined, {
        agentLaunch: true
      })
    ).toBeUndefined()
  })
})
