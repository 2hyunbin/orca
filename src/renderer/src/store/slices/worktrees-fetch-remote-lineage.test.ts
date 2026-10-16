import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control-huge-repo-warning-dismissals'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeLineage, makeWorkspaceLineage, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

const runtimeKey = (id: string) => composeWorktreeHostIdentity('runtime:env-1', id)

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('fetchWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    clearHugeRepoWarningDismissalsForTests()
  })

  it('updates remote worktree records when only lineage changes', async () => {
    const store = createTestStore()
    const initial = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    const lineage = makeLineage({ worktreeId: initial.id })
    const refreshed = { ...initial, lineage }
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [initial] },
      sortEpoch: 7
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      const result =
        method === 'worktree.lineageList'
          ? { lineage: { [lineage.worktreeId]: lineage } }
          : makeDetectedResult('repo1', [refreshed])
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-remote' }
      })
    })

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([
      { ...refreshed, parentWorktreeId: lineage.parentWorktreeId }
    ])
    expect(store.getState().worktreeLineageById).toEqual({
      [runtimeKey(lineage.worktreeId)]: lineage
    })
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('updates worktree records when only GitLab link metadata changes', async () => {
    const store = createTestStore()
    const initial = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature'
    })
    const refreshed = { ...initial, linkedGitLabIssue: 321 }
    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({
      worktreesByRepo: { repo1: [initial] },
      sortEpoch: 7
    })

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('refreshes remote lineage when the worktree payload is otherwise unchanged', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    const staleLineage = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/old-parent'
    })
    const freshLineage = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/new-parent'
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      worktreeLineageById: {
        [runtimeKey(worktree.id)]: staleLineage
      },
      sortEpoch: 7
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      const result =
        method === 'worktree.lineageList'
          ? { lineage: { [freshLineage.worktreeId]: freshLineage } }
          : makeDetectedResult('repo1', [worktree])
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-remote' }
      })
    })

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([
      { ...worktree, lineage: freshLineage, parentWorktreeId: freshLineage.parentWorktreeId }
    ])
    expect(store.getState().worktreeLineageById).toEqual({
      [runtimeKey(freshLineage.worktreeId)]: freshLineage
    })
    expect(store.getState().sortEpoch).toBe(7)
  })

  it('defers remote lineage when a caller owns the final host refresh', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote'
    })
    const lineage = makeLineage({ worktreeId: worktree.id })
    const workspaceLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(worktree.id)
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: {}
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      const result =
        method === 'worktree.lineageList'
          ? {
              lineage: { [lineage.worktreeId]: lineage },
              workspaceLineage: { [workspaceLineage.childWorkspaceKey]: workspaceLineage }
            }
          : makeDetectedResult('repo1', [worktree])
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-remote' }
      })
    })

    await store.getState().fetchWorktrees('repo1', {
      executionHostId: 'runtime:env-1',
      suppressRemoteLineageRefresh: true
    })

    expect(store.getState().worktreesByRepo.repo1).toEqual([
      expect.objectContaining({ id: worktree.id, hostId: 'runtime:env-1' })
    ])
    expect(
      runtimeEnvironmentCall.mock.calls.filter(
        ([request]) => request.method === 'worktree.lineageList'
      )
    ).toHaveLength(0)

    await store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })

    expect(
      runtimeEnvironmentCall.mock.calls.filter(
        ([request]) => request.method === 'worktree.lineageList'
      )
    ).toHaveLength(1)
    expect(store.getState().worktreeLineageById).toEqual({
      [runtimeKey(lineage.worktreeId)]: lineage
    })
    expect(store.getState().workspaceLineageByChildKey).toEqual({
      [runtimeKey(workspaceLineage.childWorkspaceKey)]: workspaceLineage
    })
  })

  it.each(['create', 'reassign', 'delete'] as const)(
    'preserves a concurrent %s in both maps over a stale host reply',
    async (change) => {
      const store = createTestStore()
      const worktree = makeWorktree({
        id: 'repo1::/remote/wt1',
        hostId: 'runtime:env-1'
      })
      const before = makeLineage({ worktreeId: worktree.id })
      const childKey = worktreeWorkspaceKey(worktree.id)
      const beforeWorkspace = makeWorkspaceLineage({ childWorkspaceKey: childKey })
      const oldRows = change === 'create' ? {} : { [runtimeKey(worktree.id)]: before }
      const oldWorkspace = change === 'create' ? {} : { [runtimeKey(childKey)]: beforeWorkspace }
      store.setState({
        worktreesByRepo: { repo1: [worktree] },
        worktreeLineageById: oldRows,
        workspaceLineageByChildKey: oldWorkspace
      })
      const reply = Promise.withResolvers<unknown>()
      runtimeEnvironmentCall.mockReturnValue(reply.promise)
      const pending = store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })
      const updated = { ...before, parentWorktreeId: 'repo1::/remote/new-parent' }
      const updatedWorkspace = {
        ...beforeWorkspace,
        parentWorkspaceKey: worktreeWorkspaceKey(updated.parentWorktreeId)
      }
      const worktreeLineageById = change === 'delete' ? {} : { [runtimeKey(worktree.id)]: updated }
      const workspaceLineageByChildKey =
        change === 'delete' ? {} : { [runtimeKey(childKey)]: updatedWorkspace }
      store.setState({ worktreeLineageById, workspaceLineageByChildKey })
      reply.resolve({
        id: 'rpc-1',
        ok: true,
        result: { lineage: oldRows, workspaceLineage: oldWorkspace }
      })
      await pending
      expect(store.getState().worktreeLineageById).toEqual(worktreeLineageById)
      expect(store.getState().workspaceLineageByChildKey).toEqual(workspaceLineageByChildKey)
    }
  )

  it('drops a host lineage row the refresh reply no longer reports', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1'
    })
    const stale = makeLineage({ worktreeId: worktree.id })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      worktreeLineageById: {
        [runtimeKey(stale.worktreeId)]: stale
      }
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) =>
      Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result:
          method === 'worktree.lineageList'
            ? { lineage: {}, workspaceLineage: {} }
            : makeDetectedResult('repo1', [worktree]),
        _meta: { runtimeId: 'runtime-remote' }
      })
    )

    await store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })

    expect(store.getState().worktreeLineageById).toEqual({})
  })

  it('keeps a successful remote worktree refresh when lineage refresh fails', async () => {
    const store = createTestStore()
    const refreshed = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote'
    })
    const staleLineage = makeLineage({ worktreeId: refreshed.id })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: {},
      worktreeLineageById: {
        [runtimeKey(staleLineage.worktreeId)]: staleLineage
      },
      sortEpoch: 7
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.lineageList') {
        return Promise.reject(new Error('lineage timeout'))
      }
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result: makeDetectedResult('repo1', [refreshed]),
        _meta: { runtimeId: 'runtime-remote' }
      })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([
      {
        ...refreshed,
        hostId: 'runtime:env-1',
        runtimeOwnerEnvironmentId: 'env-1'
      }
    ])
    expect(store.getState().worktreeLineageById).toEqual({
      [runtimeKey(staleLineage.worktreeId)]: staleLineage
    })
    expect(store.getState().sortEpoch).toBe(8)
  })
})
