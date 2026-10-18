import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { SLEEPING_SWEEP_SETTLE_MS } from '../../../shared/sidebar-list/sleeping-sweep-retention'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { SidebarClock } from './sidebar-clock'
import { SidebarRetentionOwner } from './sidebar-retention-owner'

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/tmp/${id}`,
    head: 'abc',
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

function harness(worktrees: Worktree[]) {
  const world: {
    showSleeping: boolean
    worktrees: Worktree[]
    active: Set<string>
    tabsOpen: Set<string>
    gate: Promise<void> | null
  } = { showSleeping: false, worktrees, active: new Set(), tabsOpen: new Set(), gate: null }
  const owner = new SidebarRetentionOwner(new SidebarClock(), {
    showSleepingWorkspaces: () => world.showSleeping,
    listRows: async () => {
      const rows = world.worktrees
      await world.gate
      return rows
    },
    retentionCandidates: () => ({
      ids: world.active,
      isActive: (id) => world.active.has(id),
      isUnverifiableGap: (id) => world.tabsOpen.has(id)
    })
  })
  return { world, owner }
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

describe('SidebarRetentionOwner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays idle until a window begins a session, and after dispose', async () => {
    const { world, owner } = harness([worktree('a')])
    owner.noteCatalogListing([worktree('a')])
    world.active = new Set(['a'])
    owner.noteActivityChange()
    await flush()
    expect(owner.snapshot()).toEqual({ revision: 0, sessionId: null, retention: null })
    expect(vi.getTimerCount()).toBe(0)

    owner.beginSession('s1')
    owner.dispose()
    owner.noteActivityChange()
    await flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds a live row through a rebind gap, then lets it go on its own deadline', async () => {
    const { world, owner } = harness([worktree('a'), worktree('b')])
    owner.beginSession('s1')
    await flush()
    world.active = new Set(['a', 'b'])
    world.tabsOpen = new Set(['a'])
    owner.noteActivityChange()
    world.active = new Set()
    owner.noteActivityChange()
    // b had no terminal tab left, so its inactivity is definitive and gets no grace.
    expect(owner.snapshot().retention?.retainedIds).toEqual([
      getWorktreeHostIdentity(worktree('a'))
    ])
    await vi.advanceTimersByTimeAsync(SLEEPING_SWEEP_SETTLE_MS)
    expect(owner.snapshot().retention?.retainedIds).toEqual([])

    world.showSleeping = true
    owner.noteViewChange()
    expect(owner.snapshot().retention).toBeNull()
  })

  it('host-qualifies retained ids from the newest listing, never an older slow one', async () => {
    const { world, owner } = harness([])
    let release: () => void = () => {}
    world.gate = new Promise((resolve) => (release = resolve))
    // The session's first listing is slow, and it read no rows.
    owner.beginSession('s1')
    const remote = worktree('a', { hostId: 'ssh:box' })
    owner.noteCatalogListing([remote])
    world.active = new Set(['a'])
    world.tabsOpen = new Set(['a'])
    owner.noteActivityChange()
    world.active = new Set()
    owner.noteActivityChange()
    expect(owner.snapshot().retention?.retainedIds).toEqual([getWorktreeHostIdentity(remote)])

    release()
    await flush()
    expect(owner.snapshot().retention?.retainedIds).toEqual([getWorktreeHostIdentity(remote)])
  })
})
