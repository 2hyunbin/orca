import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import { describe, expect, it } from 'vitest'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import { recordCreatedWorktreeLineage } from './runtime-worktree-lineage-recording'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import { WorktreeCreate } from '../../shared/rpc-contract/worktree-create-params'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

function row(id: string, instanceId: string): ResolvedWorktree {
  const git = { path: id, head: '', branch: '', isBare: false, isMainWorktree: false }
  return {
    ...mergeWorktree('repo', git, { instanceId, hostId: 'local' }),
    git,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null
  }
}

describe('receiving a parent from another runtime', () => {
  it('ignores an id collision, resolves a renamed parent by instance, and rejects migration ambiguity', async () => {
    const child = row('/child', 'child-instance')
    const collision = row('/parent', 'unrelated-instance')
    let catalog = [child, collision]
    const controller = new RuntimeWorktreeLineageController({
      getStore: () => null,
      getCachedWorktrees: () => catalog,
      getDb: () => null,
      resolveWorktree: async () => collision,
      listResolvedWorktrees: async () => catalog,
      showTerminal: async () => ({ worktreeId: child.id })
    })
    const params = WorktreeCreate.parse({
      repo: 'repo',
      parentWorktreeRef: { worktreeId: collision.id, instanceId: 'parent-instance' }
    })
    const resolution = await controller.resolveCreate(params)
    expect(resolution).toMatchObject({
      parent: { type: 'external', instanceId: 'parent-instance' }
    })
    const records: Record<string, WorktreeLineage> = {}
    const result = recordCreatedWorktreeLineage(
      {
        setWorktreeLineage: (id, edge) => {
          records[id] = edge
          return edge
        },
        setWorkspaceLineage: (edge) => edge
      },
      child,
      resolution
    )
    expect(result.workspaceLineage?.parentInstanceId).toBe('parent-instance')
    const renamed = row('/renamed-parent', 'parent-instance')
    catalog = [child, collision, renamed]
    expect(await controller.resolveCreate(params)).toMatchObject({
      parent: { type: 'worktree', worktree: { id: renamed.id } }
    })
    expect(projectResolvedWorktreeLineage(catalog, records)[0].parentWorktreeId).toBe(renamed.id)
    catalog.push({ ...renamed, hostId: 'ssh:copy' })
    await expect(controller.resolveCreate(params)).rejects.toThrow('ambiguous')
    expect(projectResolvedWorktreeLineage(catalog, records)[0].parentWorktreeId).toBeNull()
    expect(() =>
      WorktreeCreate.parse({
        repo: 'repo',
        parentWorktreeRef: {
          worktreeId: child.id,
          instanceId: 'parent',
          capture: { source: 'unknown', confidence: 'inferred' }
        }
      })
    ).toThrow()
  })
})
