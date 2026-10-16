import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { WorktreeLineage } from './worktree/lineage-types'
import type { Worktree } from './worktree/types'
import { projectResolvedWorktreeLineage } from './resolved-worktree-lineage'

function worktree(id: string, instanceId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    instanceId,
    repoId: 'repo',
    path: join('workspace', id),
    head: 'abc123',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
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
    ...overrides
  }
}

function lineage(overrides: Partial<WorktreeLineage> = {}): WorktreeLineage {
  return {
    worktreeId: 'child',
    worktreeInstanceId: 'child-instance',
    parentWorktreeId: 'parent',
    parentWorktreeInstanceId: 'parent-instance',
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1,
    ...overrides
  }
}

describe('projectResolvedWorktreeLineage', () => {
  const parent = worktree('parent', 'parent-instance')
  const child = worktree('child', 'child-instance')

  it('projects exact instance-aware metadata across projects on one host', () => {
    const foreignParent = {
      ...parent,
      repoId: 'other',
      projectId: 'parent',
      hostId: 'local' as const
    }
    const ownedChild = { ...child, projectId: 'child', hostId: 'local' as const }
    const projected = projectResolvedWorktreeLineage([ownedChild, foreignParent], {
      child: lineage()
    })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: 'parent', childWorktreeIds: [], lineage: lineage() },
      { id: 'parent', parentWorktreeId: null, childWorktreeIds: ['child'], lineage: null }
    ])
  })

  it.each([
    ['stale child instance', lineage({ worktreeInstanceId: 'old-child' })],
    ['stale parent instance', lineage({ parentWorktreeInstanceId: 'old-parent' })]
  ])('rejects %s', (_label, candidate) => {
    const projected = projectResolvedWorktreeLineage([child, parent], { child: candidate })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: null, lineage: null },
      { id: 'parent', childWorktreeIds: [] }
    ])
  })

  it('keeps a parent on another machine nested after a folder rename', () => {
    const remoteParent = { ...parent, id: 'renamed-parent', hostId: 'ssh:remote' as const }
    const localChild = { ...child, hostId: 'local' as const }
    const projected = projectResolvedWorktreeLineage([localChild, remoteParent], {
      child: lineage()
    })
    expect(projected).toMatchObject([
      { parentWorktreeId: 'renamed-parent' },
      { childWorktreeIds: ['child'] }
    ])
    expect(projected[0].lineage?.parentWorktreeId).toBe('parent')
  })

  it('flattens a parent instance visible on two hosts', () => {
    const localParent = worktree('parent', 'parent-instance', { hostId: 'local' })
    const remoteParent = worktree('parent', 'parent-instance', { hostId: 'ssh:remote' })
    const localChild = worktree('child', 'child-instance', { hostId: 'local' })
    expect(
      projectResolvedWorktreeLineage([localChild, remoteParent, localParent], {
        child: lineage()
      })
    ).toMatchObject([
      { parentWorktreeId: null },
      { childWorktreeIds: [] },
      { childWorktreeIds: [] }
    ])
  })

  it('accepts legacy records when only one side has host or project identity', () => {
    const legacyChild = worktree('child', 'child-instance', {
      hostId: 'local',
      projectId: 'github:stablyai/orca'
    })

    const projected = projectResolvedWorktreeLineage([legacyChild, parent], {
      child: lineage()
    })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: 'parent', lineage: lineage() },
      { id: 'parent', childWorktreeIds: ['child'] }
    ])
  })

  it('rejects self-parent lineage', () => {
    const projected = projectResolvedWorktreeLineage([child], {
      child: lineage({
        parentWorktreeId: child.id,
        parentWorktreeInstanceId: child.instanceId!
      })
    })

    expect(projected[0]).toMatchObject({
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    })
  })

  it('suppresses only the newest edge in a multi-node cycle without hiding valid descendants', () => {
    const grandchild = worktree('grandchild', 'grandchild-instance')
    const parentToChild = lineage({
      worktreeId: parent.id,
      worktreeInstanceId: parent.instanceId!,
      parentWorktreeId: child.id,
      parentWorktreeInstanceId: child.instanceId!
    })
    const grandchildToParent = lineage({
      worktreeId: grandchild.id,
      worktreeInstanceId: grandchild.instanceId!
    })

    const projected = projectResolvedWorktreeLineage([child, parent, grandchild], {
      child: lineage(),
      parent: parentToChild,
      grandchild: grandchildToParent
    })

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: null, childWorktreeIds: ['parent'], lineage: null },
      {
        id: 'parent',
        parentWorktreeId: 'child',
        childWorktreeIds: ['grandchild'],
        lineage: parentToChild
      },
      { id: 'grandchild', parentWorktreeId: 'parent', lineage: grandchildToParent }
    ])
  })

  it('rejects a missing parent without mutating the raw lineage record', () => {
    const rawLineage = lineage()
    const projected = projectResolvedWorktreeLineage([child], { child: rawLineage })

    expect(projected[0]).toMatchObject({ parentWorktreeId: null, lineage: null })
    expect(rawLineage.parentWorktreeId).toBe('parent')
  })

  it('replaces disagreeing parent and child projections from the validated lineage record', () => {
    const projected = projectResolvedWorktreeLineage(
      [
        { ...child, parentWorktreeId: 'stale-parent', childWorktreeIds: ['stale-child'] },
        { ...parent, parentWorktreeId: 'stale-parent', childWorktreeIds: [] }
      ] as (Worktree & { parentWorktreeId: string; childWorktreeIds: string[] })[],
      { child: lineage() }
    )

    expect(projected).toMatchObject([
      { id: 'child', parentWorktreeId: 'parent', childWorktreeIds: [] },
      { id: 'parent', parentWorktreeId: null, childWorktreeIds: ['child'] }
    ])
  })
})
