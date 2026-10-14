import { describe, expect, it } from 'vitest'
import { foldHostProjectCatalogs } from '../../../src/shared/all-host-project-catalog'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { RpcResponse } from '../transport/types'
import { fetchHostProjectCatalog } from './host-project-catalog'
import { buildSections, type Worktree } from './workspace-list-sections'

const orcaRemote = {
  canonicalKey: 'github.com/stablyai/orca',
  remoteName: 'origin',
  remoteUrl: 'git@github.com:stablyai/orca.git'
}

const localRepos = [
  { id: 'stably', path: '/Users/jinwoo/stably/orca', displayName: 'orca', addedAt: 1 },
  {
    id: 'workspace',
    path: '/Users/jinwoo/orca/workspaces/orca/orca',
    displayName: 'orca',
    addedAt: 1
  }
].map((repo) => ({ ...repo, badgeColor: '#737373', gitRemoteIdentity: orcaRemote }))

type Answer = { result: unknown } | { error: string }

function hostAnswering(answers: Record<string, Answer>): {
  client: RpcOperationSender
  calls: string[]
} {
  const calls: string[] = []
  const client: RpcOperationSender = {
    sendRequest: async (method: string): Promise<RpcResponse> => {
      calls.push(method)
      const answer = answers[method] ?? { error: 'method_not_found' }
      return 'result' in answer
        ? { id: method, ok: true, result: answer.result }
        : { id: method, ok: false, error: { code: answer.error, message: answer.error } }
    }
  }
  return { client, calls }
}

function row(worktreeId: string, repoId: string, hostId: ExecutionHostId): Worktree {
  return {
    worktreeId,
    repoId,
    hostId,
    repo: 'orca',
    branch: 'feature',
    displayName: worktreeId,
    path: `/tmp/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

function sectionKeys(rows: Worktree[], catalog: ReturnType<typeof foldHostProjectCatalogs>) {
  return buildSections(
    rows,
    'name',
    { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
    '',
    'repo',
    new Set(),
    { ...catalog, repoOrder: undefined, projectOrderBy: 'manual' }
  ).map((section) => ({ key: section.key, title: section.title }))
}

describe('fetchHostProjectCatalog', () => {
  it.each(['method_not_found', 'forbidden'])(
    'derives projects from repos on a desktop that answers %s for the project lists',
    async (refusal) => {
      const { client, calls } = hostAnswering({
        'repo.list': { result: { repos: localRepos } },
        'project.list': { error: refusal },
        'projectHostSetup.list': { error: refusal }
      })

      const catalog = await fetchHostProjectCatalog(client, 'local')

      expect(calls.sort()).toEqual(['project.list', 'projectHostSetup.list', 'repo.list'])
      expect(catalog?.projection).toEqual(projectHostSetupProjectionFromRepos(catalog?.repos ?? []))
      // Two checkouts of one project on one surface: one section each, path-suffixed like desktop.
      const folded = foldHostProjectCatalogs(catalog ? [catalog] : [])
      expect(
        sectionKeys([row('a', 'stably', 'local'), row('b', 'workspace', 'local')], folded)
      ).toEqual([
        { key: 'project:github:stablyai/orca::setup:stably', title: 'stably/orca' },
        { key: 'project:github:stablyai/orca::setup:workspace', title: 'orca/orca' }
      ])
    }
  )

  it("stamps a server's repos and setups with the server, as the desktop adopts them", async () => {
    const repos = [{ ...localRepos[0]!, id: 'm4', path: '/Users/m4air/orca/orca' }]
    const lists = projectHostSetupProjectionFromRepos(repos)
    const { client } = hostAnswering({
      'repo.list': { result: { repos } },
      'project.list': { result: { projects: lists.projects } },
      'projectHostSetup.list': { result: { setups: lists.setups } }
    })

    const catalog = await fetchHostProjectCatalog(client, 'runtime:m4air')

    expect(catalog?.repos.map((repo) => repo.executionHostId)).toEqual(['runtime:m4air'])
    expect(
      catalog?.projection.setups.map((setup) => [setup.hostId, setup.runtimeOwnerEnvironmentId])
    ).toEqual([['runtime:m4air', 'm4air']])
  })

  it('answers null on a transient project-list failure instead of regrouping on a guess', async () => {
    const { client } = hostAnswering({
      'repo.list': { result: { repos: localRepos } },
      'project.list': { error: 'timeout' },
      'projectHostSetup.list': { error: 'method_not_found' }
    })

    await expect(fetchHostProjectCatalog(client, 'local')).resolves.toBeNull()
  })

  it('answers null when the repos do not answer, so the caller keeps its last catalog', async () => {
    const { client } = hostAnswering({ 'repo.list': { error: 'unavailable' } })

    await expect(fetchHostProjectCatalog(client, 'local')).resolves.toBeNull()
  })
})

describe('Project section keys', () => {
  it("come from the row's repo id alone before any catalog, whatever host the row names", () => {
    const none = foldHostProjectCatalogs([])
    expect(
      sectionKeys(
        [row('ssh-row', 'remote-repo', 'ssh:box'), row('local-row', 'stably', 'local')],
        none
      )
    ).toEqual([
      { key: 'repo:stably', title: 'orca' },
      { key: 'repo:remote-repo', title: 'orca' }
    ])
  })

  it("keep a desktop row's key when a server's catalog arrives later", async () => {
    const desktop = await fetchHostProjectCatalog(
      hostAnswering({ 'repo.list': { result: { repos: localRepos } } }).client,
      'local'
    )
    const serverRepos = [{ ...localRepos[0]!, id: 'win', path: 'C:/Users/jinwo/orca/orca' }]
    const server = await fetchHostProjectCatalog(
      hostAnswering({ 'repo.list': { result: { repos: serverRepos } } }).client,
      'runtime:windows2'
    )
    const rows = [row('a', 'stably', 'local'), row('w', 'win', 'runtime:windows2')]

    const before = sectionKeys(rows, foldHostProjectCatalogs(desktop ? [desktop] : []))
    const after = sectionKeys(
      rows,
      foldHostProjectCatalogs(desktop && server ? [desktop, server] : [])
    )

    expect(before.map((section) => section.key)).toEqual([
      'project:github:stablyai/orca::setup:stably',
      'repo:win',
      'project:github:stablyai/orca::setup:workspace'
    ])
    expect(after.map((section) => section.key)).toEqual([
      'project:github:stablyai/orca::setup:stably',
      'project:github:stablyai/orca',
      'project:github:stablyai/orca::setup:workspace'
    ])
  })
})
