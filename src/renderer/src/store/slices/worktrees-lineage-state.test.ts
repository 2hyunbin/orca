import { unnestWorktrees } from '../../components/sidebar/worktree-unnest'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLineage, makeIdentifiedWorktree as occupant } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

const localRowKey = (id: string) => composeWorktreeHostIdentity('local', id)

const rpcReply = (result: unknown) => ({ id: 'reply', ok: true, result })

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

describe('worktree lineage state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it.each(['ssh:remote', 'runtime:owner-env'] as const)(
    'sets and clears only the inactive captured occupant on %s, including null replies and old-peer refresh',
    async (hostId) => {
      const store = createTestStore()
      const lineage = makeLineage()
      const local = occupant('local', 'local-child')
      const child = occupant(hostId, lineage.worktreeInstanceId)
      const localLineage = { ...lineage, worktreeInstanceId: local.instanceId }
      const localKey = localRowKey(local.id)
      const childKey = composeWorktreeHostIdentity(hostId, child.id)
      const parentSelector = 'identity:wt2:local:parent-instance'
      store.setState({
        worktreesByRepo: { repo1: [local, child] },
        activeWorktreeId: local.id,
        activeWorkspaceExecutionHostId: 'local',
        worktreeLineageById: { [localKey]: localLineage }
      })
      mockApi.worktrees.updateLineage.mockResolvedValue(lineage)
      runtimeEnvironmentCall.mockResolvedValue(
        rpcReply({ worktree: { ...child, hostId: 'local', lineage } })
      )
      await store.getState().assignWorktreeParent(child.id, {
        identity: child.identity,
        parentWorktreeId: parentSelector
      })
      expect(store.getState().worktreeLineageById).toEqual({
        [localKey]: localLineage,
        [childKey]: lineage
      })
      expect(store.getState().worktreesByRepo.repo1[0]).toBe(local)
      expect(store.getState().worktreesByRepo.repo1[1]).toMatchObject({ lineage })
      if (hostId === 'ssh:remote') {
        expect(mockApi.worktrees.updateLineage).toHaveBeenCalledWith({
          worktreeId: `identity:${child.identity.key}`,
          parentWorktreeId: parentSelector
        })
      } else {
        expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
          expect.objectContaining({
            selector: 'owner-env',
            params: {
              worktree: `identity:${child.identity.key}`,
              parentWorktree: parentSelector
            }
          })
        )
      }
      const refreshed = { lineage: { [local.id]: localLineage, [childKey]: lineage } }
      mockApi.worktrees.listLineage.mockResolvedValue(refreshed)
      runtimeEnvironmentCall.mockResolvedValue(rpcReply({ lineage: { [child.id]: lineage } }))
      await store.getState().fetchWorktreeLineage({ executionHostId: hostId })
      expect(store.getState().worktreeLineageById[childKey]).toEqual(lineage)
      mockApi.worktrees.updateLineage.mockResolvedValue(null)
      runtimeEnvironmentCall.mockResolvedValue(
        rpcReply({ worktree: { ...child, hostId: 'local', lineage: null } })
      )
      await unnestWorktrees([child], store.getState().updateWorktreeLineage)
      expect(store.getState().worktreeLineageById).toEqual({ [localKey]: localLineage })
      expect(store.getState().worktreesByRepo.repo1[0]).toBe(local)
      expect(store.getState().worktreesByRepo.repo1[1]).toMatchObject({
        parentWorktreeId: null,
        lineage: null
      })
      mockApi.worktrees.listLineage.mockResolvedValue({ lineage: { [local.id]: localLineage } })
      runtimeEnvironmentCall.mockResolvedValue(rpcReply({ lineage: {} }))
      await store.getState().fetchWorktreeLineage({ executionHostId: hostId })
      expect(store.getState().worktreeLineageById).toEqual({ [localKey]: localLineage })
    }
  )

  it('refuses missing, replaced and ambiguous identities without touching another occupant', async () => {
    const store = createTestStore()
    const child = occupant('local', 'child-instance')
    const identity = child.identity
    const clear = () =>
      store.getState().updateWorktreeLineage(child.id, { identity, noParent: true })
    await expect(clear()).rejects.toThrow('selector_not_found')
    store.setState({
      worktreesByRepo: { repo1: [child, { ...child, id: 'repo1::/second-location' }] }
    })
    await expect(clear()).rejects.toThrow('selector_not_found')
    expect(mockApi.worktrees.updateLineage).not.toHaveBeenCalled()
    store.setState({ worktreesByRepo: { repo1: [child] } })
    const reply = Promise.withResolvers<null>()
    mockApi.worktrees.updateLineage.mockReturnValue(reply.promise)
    mockApi.worktrees.listLineage.mockResolvedValue({ lineage: {} })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pending = clear()
    const replacement = occupant('local', 'replacement')
    store.setState({ worktreesByRepo: { repo1: [replacement] } })
    reply.resolve(null)
    await expect(pending).rejects.toThrow('selector_not_found')
    expect(store.getState().worktreesByRepo.repo1[0]).toBe(replacement)
  })
})
