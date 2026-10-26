import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { DetectedWorktree, Worktree } from '../../../../../../shared/worktree/types'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { buildRows } from './build-rows.test-fixture'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#000',
  addedAt: 1
}
const other: Repo = { ...repo, id: 'repo-2', path: '/other', displayName: 'other' }

function worktree(id: string, repoId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId,
    path: `/${id}`,
    head: 'abc123',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    displayName: id,
    comment: '',
    ...overrides
  }
}

const hidden = (repoId: string): DetectedWorktree => ({
  ...worktree(`${repoId}-hidden`, repoId),
  ownership: 'external',
  selectedCheckout: false,
  visible: false
})

function discoveryRows(
  groupBy: 'none' | 'workspace-status' | 'pr-status' | 'repo',
  rows: Worktree[]
) {
  return buildRows(
    groupBy,
    rows,
    new Map([
      [repo.id, repo],
      [other.id, other]
    ]),
    null,
    new Set(),
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    false,
    undefined,
    [],
    new Set(),
    new Map([[repo.id, { repo, hiddenWorktrees: [hidden(repo.id)] }]]),
    new Map([[other.id, { repo: other, inboxWorktrees: [hidden(other.id)] }]])
  )
}

type Notice = { type: Row['type']; repoId: string; placement: string | undefined }

function notices(rows: Row[]): Notice[] {
  const result: Notice[] = []
  for (const row of rows) {
    if (row.type === 'imported-worktrees-card' || row.type === 'new-external-worktrees-inbox') {
      result.push({ type: row.type, repoId: row.repo.id, placement: row.placement })
    }
  }
  return result
}

describe('workspace discovery outside project grouping', () => {
  it.each(['none', 'workspace-status', 'pr-status'] as const)(
    'suggests hidden workspaces for unpinned projects when grouped by %s',
    (groupBy) => {
      const rows = discoveryRows(groupBy, [worktree('main', repo.id), worktree('o-main', other.id)])
      expect(notices(rows)).toEqual([
        { type: 'imported-worktrees-card', repoId: repo.id, placement: 'standalone' },
        { type: 'new-external-worktrees-inbox', repoId: other.id, placement: 'standalone' }
      ])
    }
  )

  it('keeps a pinned-only project on its pinned fallback instead of repeating it', () => {
    const rows = discoveryRows('none', [worktree('main', repo.id, { isPinned: true })])
    expect(notices(rows)).toEqual([
      { type: 'new-external-worktrees-inbox', repoId: other.id, placement: 'standalone' },
      { type: 'imported-worktrees-card', repoId: repo.id, placement: 'pinned-fallback' }
    ])
  })

  it('leaves project grouping to its own section hints', () => {
    const rows = discoveryRows('repo', [worktree('main', repo.id), worktree('o-main', other.id)])
    expect(notices(rows).every((notice) => notice.placement !== 'standalone')).toBe(true)
  })
})
