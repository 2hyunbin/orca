import { unnestWorktrees } from '../../components/sidebar/worktree-unnest'
import { captureSelectedWorktree } from '@/lib/selected-worktree-reference'
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
      const child = Object.assign(
        occupant(hostId === 'runtime:owner-env' ? 'local' : hostId, lineage.worktreeInstanceId),
        { hostId }
      )
      const localLineage = { ...lineage, worktreeInstanceId: local.identity.instanceId }
      const localKey = localRowKey(local.id)
      const childKey = composeWorktreeHostIdentity(hostId, child.id)
      const parent = Object.assign(
        occupant('ssh:parent', lineage.parentWorktreeInstanceId, lineage.parentWorktreeId),
        { runtimeOwnerEnvironmentId: hostId === 'runtime:owner-env' ? 'owner-env' : undefined }
      )
      const parentSelector = `identity:${parent.identity.key}`
      store.setState({
        worktreesByRepo: { repo1: [local, child, parent] },
        activeWorktreeId: local.id,
        activeWorkspaceExecutionHostId: 'local',
        worktreeLineageById: { [localKey]: localLineage }
      })
      const reference = captureSelectedWorktree(store.getState(), child)!
      const parentReference = captureSelectedWorktree(store.getState(), parent)!
      for (const next of [lineage, null]) {
        mockApi.worktrees.updateLineage.mockResolvedValue(next)
        runtimeEnvironmentCall.mockResolvedValue(
          rpcReply({ worktree: { ...child, hostId: 'local', lineage: next } })
        )
        await (next
          ? store.getState().assignWorktreeParent(reference, { parent: parentReference })
          : unnestWorktrees([reference], store.getState().updateWorktreeLineage))
        const expected = { [localKey]: localLineage, ...(next ? { [childKey]: next } : {}) }
        expect(store.getState().worktreeLineageById).toEqual(expected)
        expect(store.getState().worktreesByRepo.repo1[0]).toBe(local)
        expect(store.getState().worktreesByRepo.repo1[1]).toMatchObject({ lineage: next })
        expect(store.getState().worktreesByRepo.repo1[2]).toMatchObject({
          childWorktreeIds: next || hostId === 'ssh:remote' ? [child.id] : []
        })
        const args = next ? { parentWorktreeId: parentSelector } : { noParent: true }
        if (hostId === 'ssh:remote') {
          expect(mockApi.worktrees.updateLineage).toHaveBeenLastCalledWith({
            worktreeId: `identity:${child.identity.key}`,
            ...args
          })
        } else {
          expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith(
            expect.objectContaining({
              selector: 'owner-env',
              params: {
                worktree: `identity:${child.identity.key}`,
                ...(next ? { parentWorktree: parentSelector } : args)
              }
            })
          )
        }
        mockApi.worktrees.listLineage.mockResolvedValue({ lineage: expected })
        runtimeEnvironmentCall.mockResolvedValue(
          rpcReply({ lineage: next ? { [child.id]: next } : {} })
        )
        await store.getState().fetchWorktreeLineage({ executionHostId: hostId })
        expect(store.getState().worktreeLineageById).toEqual(expected)
      }
    }
  )

  it('refuses missing, replaced and ambiguous identities without touching another occupant', async () => {
    const store = createTestStore()
    const child = occupant('local', 'child-instance')
    store.setState({ worktreesByRepo: { repo1: [child] } })
    const reference = captureSelectedWorktree(store.getState(), child)!
    store.setState({ worktreesByRepo: {} })
    const clear = () => store.getState().updateWorktreeLineage(reference, { noParent: true })
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
