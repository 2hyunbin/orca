import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { WorktreeCreate } from '../../shared/rpc-contract/worktree-create-params'
import { buildManagedWorktreeCreateArgs } from './rpc/methods/worktree-create-args'
import { OrcaRuntimeService } from './orca-runtime'

const REPOS: Repo[] = [
  {
    id: 'dup',
    path: '/laptop/dup',
    displayName: 'Dup',
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'local'
  },
  {
    id: 'dup',
    path: '/remote/dup',
    displayName: 'Dup',
    badgeColor: '#000',
    addedAt: 2,
    executionHostId: 'ssh:gpu'
  }
]

function createRuntime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: repo selection reads only getRepos/getRepo.
  return new OrcaRuntimeService({
    getRepos: () => REPOS,
    getRepo: (id: string) => REPOS.find((repo) => repo.id === id) ?? null,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => null,
    setWorktreeMeta: vi.fn(),
    getGitHubCache: () => null
  } as never)
}

describe('worktree.create with the same repo id on two hosts', () => {
  it('carries repoHostId from the wire into the runtime create args', () => {
    const params = WorktreeCreate.parse({ repo: 'id:dup', repoHostId: 'local', name: 'x' })
    const args = buildManagedWorktreeCreateArgs(params, {})
    expect(args).toMatchObject({ repoSelector: 'id:dup', repoHostId: 'local' })
  })

  it('keeps the selector-only shape older clients send', () => {
    const params = WorktreeCreate.parse({ repo: 'id:dup', name: 'x' })
    expect(buildManagedWorktreeCreateArgs(params, {})).not.toHaveProperty('repoHostId')
  })

  it('resolves the row on the named host', async () => {
    const runtime = createRuntime()
    await expect(runtime.showRepo('id:dup', 'local')).resolves.toMatchObject({
      path: '/laptop/dup'
    })
    await expect(runtime.showRepo('id:dup', 'ssh:gpu')).resolves.toMatchObject({
      path: '/remote/dup'
    })
  })

  it('still refuses a bare duplicated id', async () => {
    await expect(createRuntime().showRepo('id:dup')).rejects.toThrow('selector_ambiguous')
  })

  it('creation proceeds with the row on the named host', async () => {
    const runtime = createRuntime()
    const reached = vi
      .spyOn(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spies on the private step that receives the resolved repo; it exists on the prototype.
        OrcaRuntimeService.prototype as unknown as {
          createInResolvedProject: (args: unknown, repo: Repo) => Promise<never>
        },
        'createInResolvedProject'
      )
      .mockRejectedValue(new Error('stop after resolution'))

    await expect(
      runtime.createManagedWorktree({ repoSelector: 'id:dup', repoHostId: 'ssh:gpu', name: 'x' })
    ).rejects.toThrow('stop after resolution')
    expect(reached.mock.calls[0]?.[1]).toMatchObject({ path: '/remote/dup' })
    reached.mockRestore()
  })
})
