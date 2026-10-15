import { describe, expect, it } from 'vitest'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'

describe('buildRuntimeWorktreePsSummaries', () => {
  it('preserves persisted host ownership over the resolved row fallback', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the summary builder reads only these worktree fields.
    const worktree = {
      id: 'repo-1::/workspace/app',
      repoId: 'repo-1',
      hostId: 'ssh:resolved-host',
      path: '/workspace/app',
      branch: 'feature',
      isArchived: false,
      isMainWorktree: false,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      lastActivityAt: 0
    } as unknown as ResolvedWorktree
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the summary builder reads only these store methods.
    const store = {
      getRepos: () => [],
      getWorktreeMeta: () => ({
        hostId: 'ssh:persisted-host',
        linkedPR: 42,
        linkedItems: [{ provider: 'github', type: 'pr', number: 57 }]
      }),
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [],
      getProjectGroups: () => []
    } as unknown as RuntimeStore

    const summary = buildRuntimeWorktreePsSummaries({
      store,
      resolvedWorktrees: [worktree],
      platformByRepoId: new Map()
    }).get(worktree.id)

    expect(summary?.hostId).toBe('ssh:persisted-host')
    expect(summary?.linkedItems).toEqual([
      { provider: 'github', type: 'pr', number: 57 },
      { provider: 'github', type: 'pr', number: 42 }
    ])
  })

  it('carries the error of a failed delete the host still lists', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only these fields for a git row.
    const worktree = {
      id: 'repo-1::/workspace/app',
      repoId: 'repo-1',
      path: '/workspace/app',
      branch: 'feature',
      isArchived: false,
      isMainWorktree: false,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      lastActivityAt: 0,
      removalError: 'Operation not permitted'
    } as unknown as ResolvedWorktree
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only these store members.
    const store = {
      getRepos: () => [],
      getWorktreeMeta: () => undefined,
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [],
      getProjectGroups: () => []
    } as unknown as RuntimeStore

    const summary = buildRuntimeWorktreePsSummaries({
      store,
      resolvedWorktrees: [worktree],
      platformByRepoId: new Map()
    }).get(worktree.id)

    expect(summary?.removalError).toBe('Operation not permitted')
  })

  it('sends the Workspace options row facts the sidebar reads', () => {
    const row = (id: string, fields: Record<string, unknown>) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only these fields for a git row.
      ({
        id,
        repoId: 'repo-1',
        path: `/workspace/${id}`,
        branch: 'feature',
        head: 'abc1234',
        isArchived: false,
        isMainWorktree: false,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        lastActivityAt: 0,
        ...fields
      }) as unknown as ResolvedWorktree
    const worktrees = [
      row('main', { isMainWorktree: true, branch: 'refs/heads/main' }),
      row('automation', { automationProvenance: { kind: 'created-by-automation' } }),
      row('cli', { cliProvenance: { kind: 'created-by-cli', createdAt: 0 } }),
      row('detached', { branch: '' }),
      row('folder-root', { repoId: 'folder-repo', isMainWorktree: true, branch: '', head: '' })
    ]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only these store members.
    const store = {
      getRepos: () => [
        { id: 'repo-1', path: '/r', displayName: 'Repo', badgeColor: '#000', addedAt: 0 },
        {
          id: 'folder-repo',
          path: '/f',
          displayName: 'Folder',
          badgeColor: '#000',
          addedAt: 0,
          kind: 'folder'
        }
      ],
      getWorktreeMeta: () => undefined,
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [],
      getProjectGroups: () => []
    } as unknown as RuntimeStore

    const summaries = buildRuntimeWorktreePsSummaries({
      store,
      resolvedWorktrees: worktrees,
      platformByRepoId: new Map()
    })
    const facts = (id: string) => {
      const summary = summaries.get(id)
      return {
        defaultBranchWorkspace: summary?.defaultBranchWorkspace,
        automationCreated: summary?.automationCreated,
        cliCreated: summary?.cliCreated,
        detachedHead: summary?.detachedHead
      }
    }
    const none = { automationCreated: undefined, cliCreated: undefined, detachedHead: undefined }
    expect(facts('main')).toEqual({ ...none, defaultBranchWorkspace: true })
    expect(facts('automation')).toEqual({
      ...none,
      defaultBranchWorkspace: false,
      automationCreated: true
    })
    expect(facts('cli')).toEqual({ ...none, defaultBranchWorkspace: false, cliCreated: true })
    expect(facts('detached')).toEqual({
      ...none,
      defaultBranchWorkspace: false,
      detachedHead: true
    })
    expect(facts('folder-root')).toEqual({ ...none, defaultBranchWorkspace: true })
  })
})
