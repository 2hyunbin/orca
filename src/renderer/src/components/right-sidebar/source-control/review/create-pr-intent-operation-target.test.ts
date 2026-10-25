import { describe, expect, it, vi } from 'vitest'
import { createPrIntentOperationTarget } from './use-create-pr-intent-target'
import type { CreatePrIntentRunToken } from './create-pr-intent-flow'

vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))

const token: Omit<CreatePrIntentRunToken, 'pinnedCopy'> = {
  repoId: 'repo1',
  worktreeId: 'repo1::/srv/ai-tools',
  worktreePath: '/srv/ai-tools',
  branch: 'feature',
  provider: 'github',
  startedAt: 0
}
const deps = {
  activeRepoTarget: { kind: 'local' as const },
  pushTarget: undefined,
  bareConnectionId: () => null
}

// #32918: the same project at the same path locally and on an SSH host share one worktree id.
describe('createPrIntentOperationTarget', () => {
  it("refuses when the run's copy did not resolve, never using the local twin", () => {
    const target = createPrIntentOperationTarget({ ...token, pinnedCopy: null }, deps)

    expect(target).toMatchObject({ target: null, connectionId: undefined, ownerHostId: null })
  })

  it('keeps the transport and SSH target captured when the run started', () => {
    const pinnedCopy = {
      worktreeId: token.worktreeId,
      hostId: 'runtime:hub-a' as const,
      connectionId: 'private-target',
      transport: { kind: 'environment' as const, environmentId: 'hub-a' }
    }

    const target = createPrIntentOperationTarget({ ...token, pinnedCopy }, deps)

    expect(target).toMatchObject({
      target: pinnedCopy.transport,
      connectionId: 'private-target',
      ownerHostId: 'runtime:hub-a'
    })
  })
})
