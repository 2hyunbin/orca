import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
}))

import { resolveRuntimeGitHubWorktreeBase } from './runtime-github-worktree-base'
import { resolveRuntimeGitLabWorktreeBase } from './runtime-gitlab-worktree-base'

const store = { getProjects: () => [], getSettings: () => ({}) }

function repoOn(fields: Pick<Repo, 'connectionId' | 'executionHostId'>): Repo {
  return {
    id: 'repo-1',
    path: '/srv/project',
    displayName: 'project',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...fields
  }
}

describe('runtime PR/MR worktree base on an SSH project', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'local-sha\n', stderr: '' })
  })

  // Why: rows written by the unified-host code carry only `ssh:<target>`, no legacy connectionId.
  it.each([
    ['executionHostId only', { executionHostId: 'ssh:gpu' as const }],
    ['legacy connectionId', { connectionId: 'gpu' }]
  ])('GitHub refuses instead of running local git (%s)', async (_label, fields) => {
    const resolveRepo = vi.fn(async () => repoOn(fields))
    await expect(
      resolveRuntimeGitHubWorktreeBase(
        { repoSelector: 'id:repo-1', prNumber: 7, headRefName: 'feature' },
        { store, resolveRepo }
      )
    ).rejects.toEqual(new SshHostNotServedError('gpu'))
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it.each([
    ['executionHostId only', { executionHostId: 'ssh:gpu' as const }],
    ['legacy connectionId', { connectionId: 'gpu' }]
  ])('GitLab refuses instead of running local git (%s)', async (_label, fields) => {
    const resolveRepo = vi.fn(async () => repoOn(fields))
    await expect(
      resolveRuntimeGitLabWorktreeBase(
        { repoSelector: 'id:repo-1', mrIid: 7, sourceBranch: 'feature', targetBranch: 'main' },
        { store, resolveRepo }
      )
    ).rejects.toEqual(new SshHostNotServedError('gpu'))
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('a runtime-stamped row registered on this host still resolves locally', async () => {
    const resolveRepo = vi.fn(async () => repoOn({ executionHostId: 'runtime:self' }))
    await expect(
      resolveRuntimeGitLabWorktreeBase(
        { repoSelector: 'id:repo-1', mrIid: 7, sourceBranch: 'feature', targetBranch: 'main' },
        { store, resolveRepo }
      )
    ).resolves.toMatchObject({ baseBranch: expect.any(String) })
    expect(gitExecFileAsyncMock).toHaveBeenCalled()
  })
})
