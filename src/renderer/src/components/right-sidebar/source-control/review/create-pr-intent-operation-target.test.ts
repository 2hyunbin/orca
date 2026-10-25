import { describe, expect, it, vi } from 'vitest'
import { createPrIntentOperationTarget } from './use-create-pr-intent-target'
import type { CreatePrIntentRunToken } from './create-pr-intent-flow'

vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/worktree-git-copy', () => ({ resolveWorktreeGitCopyNow: () => null }))

const token: CreatePrIntentRunToken = {
  repoId: 'repo1',
  worktreeId: 'repo1::/srv/ai-tools',
  worktreePath: '/srv/ai-tools',
  branch: 'feature',
  provider: 'github',
  ownerHostId: 'ssh:box-b',
  startedAt: 0
}

describe('createPrIntentOperationTarget', () => {
  it("refuses when the run's SSH copy no longer resolves, never using the local twin", () => {
    const target = createPrIntentOperationTarget(token, {
      activeRepoTarget: { kind: 'local' },
      pushTarget: undefined,
      resolveCopy: () => null,
      bareConnectionId: () => null
    })

    expect(target).toMatchObject({
      target: null,
      connectionId: undefined,
      ownerHostId: 'ssh:box-b'
    })
  })

  it("routes to the run's own copy when it resolves", () => {
    const target = createPrIntentOperationTarget(token, {
      activeRepoTarget: { kind: 'local' },
      pushTarget: undefined,
      resolveCopy: (worktreeId, hostId) => ({
        worktreeId,
        hostId: hostId ?? null,
        connectionId: 'box-b',
        transport: { kind: 'local' }
      }),
      bareConnectionId: () => null
    })

    expect(target).toMatchObject({ target: { kind: 'local' }, connectionId: 'box-b' })
  })
})
