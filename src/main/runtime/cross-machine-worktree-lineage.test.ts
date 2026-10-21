import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'
import { describe, expect, it, vi } from 'vitest'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
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
    ...mergeWorktree(
      'repo',
      git,
      mergeWorktreeMetaForWrite(undefined, { instanceId: id, hostId: 'local', sortOrder: 0 })
    ),
    id,
    git,
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
  const store = {
    getRepo: () => undefined,
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getSettings: () => ({
      workspaceDir: '',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getAllWorktreeMeta: () =>
      Object.fromEntries(
        Object.values(links)
          .flatMap((e) => [e.worktreeId, e.parentWorktreeId])
          .map((id) => [id, row(id)])
      ),
    getAllWorktreeLineage: () => links,
    getWorktreeMeta: (id: string) => row(id),
    getRepos: () => [],
    getWorktreeLineage: (id: string) => links[id],
    getAllWorkspaceLineage: () => ({}),
    setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
    removeWorktreeLineage: vi.fn(),
    setWorktreeLineage: vi.fn((_target, lineage: WorktreeLineage) => lineage),
    setWorkspaceLineage: vi.fn<NonNullable<RuntimeStore['setWorkspaceLineage']>>(
      (lineage) => lineage
    )
  } satisfies RuntimeStore
  const controller = new RuntimeWorktreeLineageController({
    getStore: () => store,
    getDb: () => null,
    resolveWorktree: async (id) => row(id),
    listResolvedWorktrees: async () => [],
    showTerminal: async () => ({ worktreeId: 'parent' })
  })
  return { controller, store }
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
    const externalAncestry = 'chain reaches another Orca install'
    const cases: [Record<string, WorktreeLineage>, string, string, string][] = [
      [{ Q: edge('Q', 'R', true) }, 'P', 'Q', externalAncestry],
      [{ C: edge('C', 'P', true) }, 'R', 'C', externalAncestry],
      [{ Q: edge('Q', 'R'), R: edge('R', 'C', true) }, 'P', 'Q', externalAncestry],
      [{ C: edge('C', 'P', true), P: edge('P', 'C') }, 'C', 'P', 'cycle'],
      [{ Q: edge('Q', 'P') }, 'P', 'Q', 'cycle'],
      [{ C: edge('C', 'P'), P: edge('P', 'Q'), Q: edge('Q', 'C') }, 'C', 'Q', 'cycle']
    ]
    for (const [links, child, parent, error] of cases) {
      expect(() => setup(links).controller.validateParent(row(child), row(parent))).toThrow(error)
    }
    const { controller } = setup({ C: edge('C', 'P', true) })
    expect(() => controller.validateParent(row('C'), row('P'))).not.toThrow()
    expect(() =>
      controller.validateParent(row('C'), { ...row('P'), hostId: 'runtime:server' })
    ).not.toThrow()
  })
  it('follows a legacy folder link in the saved chain before refusing external ancestry', () => {
    const { store, controller } = setup({ Q: edge('Q', 'R', true) })
    Object.assign(store, {
      getFolderWorkspaces: () => [{ id: 'F' }],
      getAllWorkspaceLineage: () => ({
        'folder:F': {
          childWorkspaceKey: 'folder:F',
          parentWorkspaceKey: 'worktree:Q',
          childInstanceId: null,
          parentInstanceId: 'Q'
        }
      })
    })
    expect(() => controller.validateParent(row('P'), row('folder:F'))).toThrow(
      'chain reaches another Orca install'
    )
  })
  it('uses the selected parent saved-null authority instead of another host raw external edge', async () => {
    const { store, controller } = setup({ P: edge('P', 'Q', true) })
    Object.assign(store, {
      getAllWorktreeMeta: () => ({ P: { ...row('P'), hostId: 'ssh:owner' } })
    })
    const parent = { ...row('P'), savedLineage: null }
    const child = row('C')
    const resolveWorktree = vi.fn(async (selector: string) =>
      selector === 'id:P' ? parent : child
    )
    await updateRuntimeManagedWorktreeMetadata({
      selector: 'id:C',
      updates: {
        lineage: { parentWorktreeRef: { worktreeId: 'P', instanceId: 'P', external: false } }
      },
      store,
      ports: {
        resolveWorktree,
        validateParent: (c, p) => controller.validateParent(c, p),
        invalidateResolved: vi.fn(),
        invalidateScan: vi.fn(),
        notifyChanged: vi.fn(),
        showWorktree: async () => child
      }
    })
    expect(resolveWorktree).toHaveBeenCalledWith('id:P', 'P')
    expect(store.setWorktreeLineage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentWorktreeId: 'P' })
    )
    expect(() => controller.validateParent(child, { ...row('P'), hostId: 'ssh:owner' })).toThrow(
      'chain reaches another Orca install'
    )
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
    const update = (lineage: {
      parentWorktreeRef?: { worktreeId: string; instanceId: string; external: boolean }
      noParent?: boolean
    }) =>
      updateRuntimeManagedWorktreeMetadata({ selector: 'id:C', updates: { lineage }, store, ports })
    const ref = (id: string, external = true) => ({
      parentWorktreeRef: { worktreeId: id, instanceId: id, external }
    })
    await update(ref('P'))
    expect(ports.resolveWorktree).toHaveBeenCalledTimes(1)
    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    await expect(update(ref('Q'))).rejects.toThrow('chain reaches another Orca install')
    await update({ noParent: true })
    expect(store.removeWorktreeLineage).toHaveBeenCalledOnce()
    ports.resolveWorktree.mockImplementation(async (id?: string) => row(id === 'id:P' ? 'P' : 'C'))
    await update(ref('P', false))
    expect(ports.validateParent).toHaveBeenCalledWith(row('C'), row('P'))
    expect(store.setWorktreeLineage).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ parentStore: 'external' })
    )
  })
})
