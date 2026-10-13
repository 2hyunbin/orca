import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import { CREATE_GRACE_MS } from '../../smart-sort'
import { compareFolderWorkspacesForDisplay } from './folder-workspace-lanes'

function folder(name: string, overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: name,
    name,
    projectGroupId: 'folders',
    folderPath: `/tmp/${name}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    createdAt: 1,
    lastActivityAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('folder workspace sorting policy', () => {
  it('Manual honors user order before the legacy saved order', () => {
    const left = folder('A', { manualOrder: 2, sortOrder: 1 })
    const right = folder('B', { manualOrder: 1, sortOrder: 2 })
    expect(compareFolderWorkspacesForDisplay(left, right, 'manual', 1_000_000)).toBeLessThan(0)
  })

  it('Recent keeps a new folder above noisy activity only during the creation grace window', () => {
    const createdAt = 1_000_000
    const fresh = folder('Fresh', { createdAt, lastActivityAt: createdAt })
    const active = folder('Active', { lastActivityAt: createdAt + 10 })
    expect(compareFolderWorkspacesForDisplay(fresh, active, 'recent', createdAt + 20)).toBeLessThan(
      0
    )
    expect(
      compareFolderWorkspacesForDisplay(fresh, active, 'recent', createdAt + CREATE_GRACE_MS)
    ).toBeGreaterThan(0)
  })

  it('uses name for equal activity and saved ranks', () => {
    for (const sortBy of ['recent', 'manual', 'smart'] as const) {
      expect(
        compareFolderWorkspacesForDisplay(folder('A'), folder('B'), sortBy, 1_000_000)
      ).toBeLessThan(0)
    }
  })
})
