import { describe, expect, it } from 'vitest'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import {
  buildWorktreeComparator,
  CREATE_GRACE_MS,
  effectiveRecentActivity,
  sortWorktreesSmart
} from './smart-sort'

// Smart and Recent order by the owning host's stamps (stamp-order.test.ts); no window attention sort.

const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()

const repoMap = new Map<string, Repo>([
  [
    'repo-1',
    {
      id: 'repo-1',
      path: '/tmp/repo-1',
      displayName: 'repo-1',
      badgeColor: '#000000',
      addedAt: 0
    }
  ]
])

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? `/tmp/${overrides.id ?? 'wt-1'}`,
    branch: overrides.branch ?? `refs/heads/${overrides.id ?? 'wt-1'}`,
    head: overrides.head ?? 'abc123',
    isBare: overrides.isBare ?? false,
    isMainWorktree: overrides.isMainWorktree ?? false,
    linkedIssue: overrides.linkedIssue ?? null,
    linkedPR: overrides.linkedPR ?? null,
    linkedLinearIssue: null,
    isArchived: overrides.isArchived ?? false,
    comment: overrides.comment ?? '',
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    displayName: overrides.displayName ?? overrides.id ?? 'wt-1',
    sortOrder: overrides.sortOrder ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 0,
    ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {})
  }
}

describe('sortWorktreesSmart — labels', () => {
  it('falls back to the path label when a persisted worktree has no displayName', () => {
    const missingDisplayName = {
      ...makeWorktree({
        id: 'missing-display-name',
        path: '/tmp/alpha-path',
        sortOrder: 1
      }),
      displayName: undefined
    } as unknown as Worktree
    const named = makeWorktree({ id: 'named', displayName: 'Zulu', sortOrder: 1 })

    const sorted = sortWorktreesSmart([named, missingDisplayName], {}, repoMap, {}, {}, {})

    expect(sorted.map((w) => w.id)).toEqual(['missing-display-name', 'named'])
  })
})

describe('buildWorktreeComparator — recent (lastActivityAt)', () => {
  it('sorts by lastActivityAt descending (most recent first)', () => {
    const older = makeWorktree({
      id: 'older',
      displayName: 'Older',
      lastActivityAt: 1000
    })
    const newer = makeWorktree({
      id: 'newer',
      displayName: 'Newer',
      lastActivityAt: 2000
    })
    const worktrees = [older, newer]

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['newer', 'older'])
  })

  it('sorts worktrees with lastActivityAt 0 to the bottom', () => {
    const touched = makeWorktree({
      id: 'touched',
      displayName: 'Touched',
      lastActivityAt: 1000
    })
    const legacy = makeWorktree({
      id: 'legacy',
      displayName: 'Legacy',
      lastActivityAt: 0
    })
    const worktrees = [legacy, touched]

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['touched', 'legacy'])
  })

  it('falls back to alphabetical when lastActivityAt is equal', () => {
    const bravo = makeWorktree({
      id: 'bravo',
      displayName: 'Bravo',
      lastActivityAt: 1000
    })
    const alpha = makeWorktree({
      id: 'alpha',
      displayName: 'Alpha',
      lastActivityAt: 1000
    })
    const worktrees = [bravo, alpha]

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['alpha', 'bravo'])
  })

  it('ignores sortOrder entirely — activity alone determines the order', () => {
    const staleHighOrder = makeWorktree({
      id: 'stale-high-order',
      displayName: 'Orca main',
      sortOrder: 9_999_999_999_999,
      lastActivityAt: 1000
    })
    const freshActive = makeWorktree({
      id: 'fresh-active',
      displayName: 'Other repo',
      sortOrder: 1,
      lastActivityAt: 5000
    })
    const worktrees = [staleHighOrder, freshActive]

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['fresh-active', 'stale-high-order'])
  })
})

describe('effectiveRecentActivity — create-grace floor', () => {
  it('returns lastActivityAt when createdAt is absent', () => {
    const wt = makeWorktree({ id: 'old', lastActivityAt: 12345 })
    expect(effectiveRecentActivity(wt, NOW)).toBe(12345)
  })

  it('returns createdAt + CREATE_GRACE_MS when grace window exceeds lastActivityAt', () => {
    const wt = makeWorktree({ id: 'fresh', lastActivityAt: NOW, createdAt: NOW })
    expect(effectiveRecentActivity(wt, NOW)).toBe(NOW + CREATE_GRACE_MS)
  })

  it('returns lastActivityAt when grace window has elapsed', () => {
    const wt = makeWorktree({
      id: 'post-grace',
      createdAt: NOW - CREATE_GRACE_MS - 60_000,
      lastActivityAt: NOW - 1000
    })
    expect(effectiveRecentActivity(wt, NOW)).toBe(NOW - 1000)
  })

  it('returns lastActivityAt when real activity has surpassed the grace floor', () => {
    const createdAt = NOW - 3 * 60 * 1000
    const wt = makeWorktree({ id: 'used', createdAt, lastActivityAt: NOW - 60_000 })
    expect(effectiveRecentActivity(wt, NOW)).toBe(createdAt + CREATE_GRACE_MS)
  })

  it('returns lastActivityAt once the grace window has elapsed even when no other activity has occurred', () => {
    const createdAt = NOW - CREATE_GRACE_MS - 1
    const wt = makeWorktree({ id: 'untouched', createdAt, lastActivityAt: createdAt })
    expect(effectiveRecentActivity(wt, NOW)).toBe(createdAt)
  })
})

describe('buildWorktreeComparator — manual order', () => {
  it('orders by persisted manualOrder with higher values first', () => {
    const first = makeWorktree({ id: 'first', displayName: 'First', manualOrder: 3000 })
    const second = makeWorktree({ id: 'second', displayName: 'Second', manualOrder: 2000 })
    const worktrees = [second, first]

    worktrees.sort(buildWorktreeComparator('manual', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['first', 'second'])
  })

  it('falls back to sortOrder before a workspace has manualOrder', () => {
    const restoredTop = makeWorktree({
      id: 'restored-top',
      displayName: 'Restored Top',
      sortOrder: 5000
    })
    const restoredBottom = makeWorktree({
      id: 'restored-bottom',
      displayName: 'Restored Bottom',
      sortOrder: 1000
    })
    const worktrees = [restoredBottom, restoredTop]

    worktrees.sort(buildWorktreeComparator('manual', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['restored-top', 'restored-bottom'])
  })
})

describe('buildWorktreeComparator — recent with createdAt grace window', () => {
  it('falls through to normal recency once the grace window has elapsed', () => {
    const oldCreated = makeWorktree({
      id: 'old-created',
      displayName: 'Old created',
      createdAt: NOW - CREATE_GRACE_MS - 10_000,
      lastActivityAt: NOW - 30_000
    })
    const freshActivity = makeWorktree({
      id: 'fresh-activity',
      displayName: 'Fresh activity',
      lastActivityAt: NOW - 1000
    })
    const worktrees = [oldCreated, freshActivity]

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['fresh-activity', 'old-created'])
  })
})
