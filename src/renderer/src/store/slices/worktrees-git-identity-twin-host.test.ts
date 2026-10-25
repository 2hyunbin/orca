import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { resetHostedReviewLinkMutationGenerationForTests } from './worktrees'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  resetRemoteRuntimeMocks()
  resetHostedReviewLinkMutationGenerationForTests()
})

// #32918: one project at the same path on two SSH hosts shares the id `repoId::path`.
function twinStore() {
  const store = createTestStore()
  const id = 'repo1::/srv/ai-tools'
  const onA = makeWorktree({
    id,
    repoId: 'repo1',
    path: '/srv/ai-tools',
    hostId: 'runtime:env-a',
    head: 'aaa',
    branch: 'refs/heads/master',
    displayName: 'master'
  })
  const onB = makeWorktree({
    id,
    repoId: 'repo1',
    path: '/srv/ai-tools',
    hostId: 'runtime:env-b',
    head: 'bbb',
    branch: 'refs/heads/feature',
    displayName: 'feature'
  })
  store.setState({ worktreesByRepo: { repo1: [onA, onB] } } as Partial<AppState>)
  return { store, id }
}

describe('updateWorktreeGitIdentity with a same-path twin on another host', () => {
  it("writes one host's git status only to that host's copy", () => {
    const { store, id } = twinStore()

    store
      .getState()
      .updateWorktreeGitIdentity(id, { head: 'aaa2', branch: 'refs/heads/master' }, 'runtime:env-a')

    const [onA, onB] = store.getState().worktreesByRepo.repo1
    expect(onA).toMatchObject({ head: 'aaa2', branch: 'refs/heads/master' })
    expect(onB).toMatchObject({ head: 'bbb', branch: 'refs/heads/feature', displayName: 'feature' })
  })

  it('leaves both copies alone when the answering host is unknown', () => {
    const { store, id } = twinStore()

    store
      .getState()
      .updateWorktreeGitIdentity(id, { head: 'ccc', branch: 'refs/heads/other' }, null)

    const [onA, onB] = store.getState().worktreesByRepo.repo1
    expect(onA.branch).toBe('refs/heads/master')
    expect(onB.branch).toBe('refs/heads/feature')
  })
})
