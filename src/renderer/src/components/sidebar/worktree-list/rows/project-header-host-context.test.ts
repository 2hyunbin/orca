import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import type { HostHeaderRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { SidebarHostOption } from '../../sidebar-host-options'
import {
  project,
  projectHostSetups,
  repo,
  remoteRepo
} from '../../worktree-list-groups-test-fixtures'
import { getProjectHeaderHostContexts } from './project-header-host-context'

const local = { ...repo, displayName: 'app' }
const paired: Repo = { ...local, id: 'home-app', executionHostId: 'runtime:home' }
const hosts: SidebarHostOption[] = [
  {
    id: 'local',
    label: 'Local Mac',
    detail: 'This computer',
    kind: 'local',
    health: 'local',
    presence: 'local'
  },
  {
    id: 'runtime:home',
    label: 'Home',
    detail: 'home.example',
    kind: 'runtime',
    health: 'disconnected',
    presence: 'configured'
  }
]
function header(value: Repo): GroupHeaderRow {
  return {
    type: 'header',
    key: `repo:${value.id}`,
    label: value.displayName,
    count: 1,
    icon: { kind: 'project' },
    repo: value
  }
}
const repoMap = new Map([local, paired].map((value) => [value.id, value]))
const rows = [header(local), header(paired)]
const folder: ProjectGroup = {
  id: 'folder',
  name: 'app',
  parentPath: '/projects/app',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: true,
  color: null,
  createdAt: 0,
  updatedAt: 0,
  executionHostId: 'runtime:home'
}
const folderHeader: GroupHeaderRow = {
  type: 'header',
  key: 'project-group:folder',
  label: 'app',
  count: 0,
  icon: { kind: 'project' },
  projectGroup: folder
}
const hostHeader: HostHeaderRow = {
  type: 'host-header',
  key: 'host:local',
  hostId: 'local',
  kind: 'local',
  label: 'Local Mac',
  detail: 'This computer',
  health: 'local',
  collapsed: false,
  count: 1
}

describe('project header host context', () => {
  it('keeps two collapsed same-name projects distinguishable without any workspace rows', () => {
    const contexts = getProjectHeaderHostContexts({ rows, hosts, repoMap })
    expect([...contexts.values()].map(({ label }) => label)).toEqual(['Local Mac', 'Home'])
    expect(contexts.get(rows[1]!.key)).toEqual({
      hostId: 'runtime:home',
      label: 'Home',
      detail: 'home.example'
    })
  })

  it('keeps single-host sidebars quiet even when another host is configured', () => {
    expect(getProjectHeaderHostContexts({ rows: [rows[0]!], hosts, repoMap }).size).toBe(0)
  })

  it('omits redundant labels under actual enclosing host sections', () => {
    expect(getProjectHeaderHostContexts({ rows: [hostHeader, ...rows], hosts, repoMap }).size).toBe(
      0
    )
  })

  it('does not conflate different hosts with the same custom display name', () => {
    const sameNames = hosts.map((host) => ({ ...host, label: 'My computer' }))
    const contexts = getProjectHeaderHostContexts({ rows, hosts: sameNames, repoMap })
    expect([...contexts.values()].map(({ hostId }) => hostId)).toEqual(['local', 'runtime:home'])
    expect([...contexts.values()].map(({ label }) => label)).toEqual(['My computer', 'My computer'])
    expect(new Set([...contexts.values()].map(({ detail }) => detail)).size).toBe(2)
  })

  it('resolves SSH and runtime aliases through the canonical host registry', () => {
    const ssh: Repo = { ...local, id: 'ssh-app', connectionId: 'home' }
    const aliases: SidebarHostOption[] = [
      ...hosts,
      {
        id: 'ssh:home',
        label: 'Old name',
        detail: '',
        kind: 'ssh',
        health: 'disconnected',
        presence: 'configured',
        mergedIntoHostId: 'runtime:home'
      }
    ]
    const contexts = getProjectHeaderHostContexts({
      rows: [header(local), header(ssh)],
      hosts: aliases,
      repoMap: new Map([
        [local.id, local],
        [ssh.id, ssh]
      ])
    })
    expect(contexts.get(`repo:${ssh.id}`)?.label).toBe('Home')
    expect(contexts.get(`repo:${ssh.id}`)?.hostId).toBe('runtime:home')
    expect(
      getProjectHeaderHostContexts({ rows: [header(ssh), header(paired)], hosts: aliases, repoMap })
        .size
    ).toBe(0)
  })

  it('restores managed aliases from owner configuration when feed host options omit them', () => {
    const ssh: Repo = { ...local, id: 'ssh-app', connectionId: 'home' }
    const unmerged: SidebarHostOption[] = [
      ...hosts,
      {
        id: 'ssh:home',
        label: 'My Home',
        detail: 'Configured SSH host',
        kind: 'ssh',
        health: 'disconnected',
        presence: 'configured'
      }
    ]
    const contexts = getProjectHeaderHostContexts({
      rows: [header(local), header(ssh), header(paired)],
      hosts: unmerged,
      repoMap: new Map([local, ssh, paired].map((value) => [value.id, value])),
      runtimeEnvironments: [{ id: 'home', orcadDeployment: { kind: 'ssh', sshTargetId: 'home' } }]
    })
    expect(contexts.get(`repo:${ssh.id}`)).toEqual({
      hostId: 'runtime:home',
      label: 'My Home',
      detail: 'Configured SSH host'
    })
    expect(contexts.get(`repo:${paired.id}`)).toEqual(contexts.get(`repo:${ssh.id}`))
  })

  it('preserves an authoritative alias snapshot while the relay route is changing', () => {
    const ssh: Repo = { ...local, id: 'ssh-app', connectionId: 'home' }
    const annotated: SidebarHostOption[] = [
      hosts[0]!,
      { ...hosts[1]!, aliasHostIds: ['ssh:home'] },
      {
        id: 'ssh:home',
        label: 'Home',
        detail: 'SSH',
        kind: 'ssh',
        health: 'disconnected',
        presence: 'configured',
        mergedIntoHostId: 'runtime:home'
      }
    ]
    const contexts = getProjectHeaderHostContexts({
      rows: [header(local), header(ssh), header(paired)],
      hosts: annotated,
      repoMap: new Map([local, ssh, paired].map((value) => [value.id, value])),
      runtimeEnvironments: [{ id: 'home', orcadDeployment: { kind: 'ssh', sshTargetId: 'home' } }],
      sshConnectionStates: new Map([
        ['home', { managedServer: { kind: 'relay', reason: 'failed' } }]
      ])
    })
    expect(contexts.get(`repo:${ssh.id}`)?.hostId).toBe('runtime:home')
    expect(contexts.get(`repo:${paired.id}`)?.hostId).toBe('runtime:home')
    expect(annotated[2]?.mergedIntoHostId).toBe('runtime:home')
    expect(annotated[2]?.aliasHostIds).toBeUndefined()
  })

  it('uses a folder-backed group owner even with no children and a disconnected host', () => {
    const contexts = getProjectHeaderHostContexts({
      rows: [header(local), folderHeader],
      hosts,
      repoMap
    })
    expect(contexts.get(folderHeader.key)?.label).toBe('Home')
  })

  it('does not assign a singular owner to manual project groups', () => {
    const manual = { ...folderHeader, projectGroup: { ...folder, createdFrom: 'manual' as const } }
    const contexts = getProjectHeaderHostContexts({ rows: [...rows, manual], hosts, repoMap })
    expect(contexts.has(manual.key)).toBe(false)
  })

  it('never labels a multi-host logical project with its representative repo owner', () => {
    const other = { ...paired, id: 'independent' }
    const logical: GroupHeaderRow = { ...header(repo), key: `project:${project.id}` }
    const contexts = getProjectHeaderHostContexts({
      rows: [logical, header(other)],
      hosts,
      repoMap: new Map([repo, remoteRepo, other].map((value) => [value.id, value])),
      projectGrouping: { projects: [project], projectHostSetups }
    })
    expect(contexts.has(logical.key)).toBe(false)
    expect(contexts.get(`repo:${other.id}`)?.hostId).toBe('runtime:home')
  })

  it('keeps non-project lanes unchanged', () => {
    expect(
      getProjectHeaderHostContexts({
        rows: rows.map((row) => ({ ...row, icon: { kind: 'pinned' } })),
        hosts,
        repoMap
      }).size
    ).toBe(0)
  })
})
