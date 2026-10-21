import { describe, expect, it } from 'vitest'
import { WorkspaceGitIdentity } from './workspace-git-identity'

const base = {
  id: 'repo-1::/r/a',
  hostId: 'local',
  instanceId: 'i-1',
  branch: 'refs/heads/a',
  displayName: 'a',
  displayNameMode: 'automatic',
  linkedPR: 7
} as const

describe('WorkspaceGitIdentity', () => {
  it('clears branch-scoped links on a branch switch it saw, never on the first sight', () => {
    const identity = new WorkspaceGitIdentity()
    expect(identity.observeScan([{ ...base, branch: 'refs/heads/z' }])).toEqual([])
    const clears = identity.observeScan([base])
    expect(clears).toEqual([
      {
        target: { id: base.id, hostId: 'local' },
        updates: expect.objectContaining({ linkedPR: null, linkedGitLabMR: null })
      }
    ])
    // The cleared links are what the next scan expects; the same branch clears nothing.
    expect(identity.observeScan([{ ...base, linkedPR: null }])).toEqual([])
  })

  it('keeps a link written after the last scan, which may belong to the new branch', () => {
    const identity = new WorkspaceGitIdentity()
    identity.observeScan([{ ...base, linkedPR: null }])
    expect(identity.observeScan([{ ...base, branch: 'refs/heads/b', linkedPR: 9 }])).toEqual([])
  })

  it('treats a recreated workspace as new', () => {
    const identity = new WorkspaceGitIdentity()
    identity.observeScan([base])
    expect(identity.observeScan([{ ...base, instanceId: 'i-2', branch: 'refs/heads/b' }])).toEqual(
      []
    )
  })

  it('keeps the same id on another host apart', () => {
    const identity = new WorkspaceGitIdentity()
    identity.observeScan([base])
    expect(identity.observeScan([{ ...base, hostId: 'ssh:box', branch: 'refs/heads/b' }])).toEqual(
      []
    )
  })

  it('keeps an automatic title through a detached head, and follows the next branch', () => {
    const identity = new WorkspaceGitIdentity()
    identity.observeScan([{ ...base, linkedPR: null }])
    const detached = { ...base, branch: '', displayName: 'r', linkedPR: null }
    identity.observeScan([detached])
    expect(identity.title(detached)).toBe('a')
    const next = { ...base, branch: 'refs/heads/c', displayName: 'c', linkedPR: null }
    identity.observeScan([next])
    expect(identity.title(next)).toBe('c')
    expect(identity.title({ ...detached, displayNameMode: 'fixed' })).toBe('r')
  })
})
