import { describe, expect, it, vi } from 'vitest'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import { resolveRuntimeWorktreeCreateLineage } from './runtime-worktree-lineage-resolution'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import { recordCreatedWorktreeLineage } from './runtime-worktree-lineage-recording'

function row(id: string): ResolvedWorktree {
  const git = { path: `/${id}`, head: '', branch: id, isBare: false, isMainWorktree: false }
  return {
    ...git,
    git,
    id,
    instanceId: id,
    repoId: 'repo',
    hostId: 'local',
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null
  }
}
function edge(child: string, parent: string, external = false): WorktreeLineage {
  return {
    worktreeId: child,
    worktreeInstanceId: child,
    parentWorktreeId: parent,
    parentWorktreeInstanceId: parent,
    ...(external ? { parentStore: 'external' as const } : {}),
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
}
function setup(links: Record<string, WorktreeLineage>) {
  const setWorktreeLineage = vi.fn((_target, lineage: WorktreeLineage) => lineage)
  const setWorkspaceLineage = vi.fn((lineage) => lineage)
  // SAFETY: these tests exercise only the controller's saved lineage reads and the recorder's writes.
  const store = {
    getWorktreeMeta: (id: string) => ({ instanceId: id, hostId: 'local' }),
    getRepos: () => [],
    getWorktreeLineage: (id: string) => links[id],
    getAllWorkspaceLineage: () => ({}),
    setWorktreeMeta: vi.fn(),
    removeWorktreeLineage: vi.fn(),
    setWorktreeLineage,
    setWorkspaceLineage
  } as unknown as RuntimeStore
  const controller = new RuntimeWorktreeLineageController({
    getStore: () => store,
    getDb: () => null,
    resolveWorktree: async (id) => row(id),
    listResolvedWorktrees: async () => [],
    showTerminal: async () => ({ worktreeId: 'parent' })
  })
  return { controller, store, setWorktreeLineage, setWorkspaceLineage }
}

describe('cross-machine lineage writes', () => {
  it('records a caller-resolved external parent without resolving that parent on the child server', async () => {
    const resolveParent = vi.fn()
    const resolution = await resolveRuntimeWorktreeCreateLineage(
      {
        parentWorktreeRef: {
          worktreeId: 'desktop-parent',
          instanceId: 'desktop-instance',
          external: true
        }
      },
      {
        resolveParent,
        resolveWorktreeParent: resolveParent,
        resolveTaskCandidate: vi.fn(),
        resolveCaller: vi.fn()
      }
    )
    const { store } = setup({})
    const recorded = recordCreatedWorktreeLineage(store, row('server-child'), resolution)
    expect(resolveParent).not.toHaveBeenCalled()
    expect(recorded.lineage).toMatchObject({
      parentStore: 'external',
      parentWorktreeId: 'desktop-parent',
      parentWorktreeInstanceId: 'desktop-instance'
    })
    expect(recorded.workspaceLineage).toMatchObject({
      parentStore: 'external',
      parentInstanceId: 'desktop-instance'
    })
  })

  it('refuses both reparentings that could close the four-node cross-store cycle, and allows identical reassertion', () => {
    const desktop = setup({ C: edge('C', 'P', true) })
    const server = setup({ Q: edge('Q', 'R', true) })
    expect(() => server.controller.validateParent(row('P'), row('Q'))).toThrow(
      'chain reaches another Orca install'
    )
    expect(() => desktop.controller.validateParent(row('R'), row('C'))).toThrow(
      'chain reaches another Orca install'
    )
    expect(() => desktop.controller.validateParent(row('C'), row('P'))).not.toThrow()
    const internal = setup({ Q: edge('Q', 'R'), R: edge('R', 'C', true) })
    expect(() => internal.controller.validateParent(row('P'), row('Q'))).toThrow(
      'chain reaches another Orca install'
    )
    expect(() =>
      setup({ Q: edge('Q', 'P') }).controller.validateParent(row('P'), row('Q'))
    ).toThrow('cycle')
  })
  it('reasserts an external parent without looking it up, refuses a different one, and always clears it', async () => {
    const { store } = setup({ C: edge('C', 'P', true) })
    const child = row('C')
    const ports = {
      resolveWorktree: vi.fn(async () => child),
      validateParent: vi.fn(),
      invalidateResolved: vi.fn(),
      invalidateScan: vi.fn(),
      notifyChanged: vi.fn(),
      showWorktree: vi.fn(async () => child)
    }
    await updateRuntimeManagedWorktreeMetadata({
      selector: 'id:C',
      updates: {
        lineage: { parentWorktreeRef: { worktreeId: 'P', instanceId: 'P', external: true } }
      },
      store,
      ports
    })
    expect(ports.resolveWorktree).toHaveBeenCalledTimes(1)
    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    await expect(
      updateRuntimeManagedWorktreeMetadata({
        selector: 'id:C',
        updates: {
          lineage: { parentWorktreeRef: { worktreeId: 'Q', instanceId: 'Q', external: true } }
        },
        store,
        ports
      })
    ).rejects.toThrow('chain reaches another Orca install')
    await updateRuntimeManagedWorktreeMetadata({
      selector: 'id:C',
      updates: { lineage: { noParent: true } },
      store,
      ports
    })
    expect(store.removeWorktreeLineage).toHaveBeenCalledOnce()
  })
})
