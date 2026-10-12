import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

vi.mock('../hooks', () => ({
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' })
}))
vi.mock('../worktree-runner-script', () => ({ createSetupRunnerScript: vi.fn() }))

vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, computeWorktreePath: vi.fn(), ensurePathWithinWorkspace: vi.fn() }
})

vi.mock('../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn(),
  invalidateAuthorizedRootsCacheForRepo: vi.fn()
}))

vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: vi.fn().mockResolvedValue(null)
  }
})

vi.mock('../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../git/git-username')
  return { ...actual, resolveLocalGitUsername: vi.fn(async () => '') }
})

const store = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [store.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    mobileAutoRestoreFitMs: null
  }),
  updateSettings: () => {}
}

const WORKTREE_ID = 'repo-1::/tmp/repo'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

type SessionTabsPrivate = {
  touchMobileSessionSnapshotsForPty: (ptyId: string) => void
  notifyMobileSessionTabsChanged: (worktreeId?: string) => void
}

/** A runtime whose saved session holds one terminal bound to `ptyId`. */
function runtimeWithPtyBackedTab(ptyId: string): OrcaRuntimeService {
  const session = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab-1',
          ptyId,
          worktreeId: WORKTREE_ID,
          title: 'agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf' as const, leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: ptyId }
      }
    }
  }
  return new OrcaRuntimeService({
    ...store,
    getWorkspaceSession: () => session,
    setWorkspaceSession: () => {}
  })
}

async function currentVersion(runtime: OrcaRuntimeService): Promise<number> {
  return (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).snapshotVersion
}

describe('session.tabs title/status churn coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses a rapid title-flip burst into a single emit (repro)', async () => {
    const runtime = runtimeWithPtyBackedTab('pty-1')
    const priv = runtime as unknown as SessionTabsPrivate

    const emits: number[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      emits.push(snapshot.snapshotVersion)
    })

    // A spinner-in-title agent flips the title ~20 times within a second.
    const FLIPS = 20
    for (let i = 0; i < FLIPS; i++) {
      priv.touchMobileSessionSnapshotsForPty('pty-1')
      vi.advanceTimersByTime(10)
    }
    // Nothing has fired yet — all flips landed inside the trailing window.
    expect(emits).toHaveLength(0)

    vi.advanceTimersByTime(50)

    // Pre-fix this fanned out one emit per flip; now it is a single emit.
    expect(emits).toHaveLength(1)
    // The emitted version is the freshest (monotonic, never a stale one).
    expect(emits[0]).toBe(await currentVersion(runtime))

    unsubscribe()
  })

  it('lets a structural change emit immediately and supersede the coalesced notify', () => {
    const runtime = runtimeWithPtyBackedTab('pty-1')
    const priv = runtime as unknown as SessionTabsPrivate

    const emits: number[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      emits.push(snapshot.snapshotVersion)
    })

    // Title churn schedules a coalesced notify...
    priv.touchMobileSessionSnapshotsForPty('pty-1')
    // ...then a structural change (e.g. tab activated) demands a prompt emit.
    priv.notifyMobileSessionTabsChanged(WORKTREE_ID)
    expect(emits).toHaveLength(1)

    // The immediate emit cancelled the pending coalesced notify — no duplicate trailing emit.
    vi.advanceTimersByTime(50)
    expect(emits).toHaveLength(1)

    unsubscribe()
  })

  it('flushes a pending notify when the last subscriber closes', () => {
    const runtime = runtimeWithPtyBackedTab('pty-1')
    const priv = runtime as unknown as SessionTabsPrivate

    const emits: number[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      emits.push(snapshot.snapshotVersion)
    })

    priv.touchMobileSessionSnapshotsForPty('pty-1')
    expect(emits).toHaveLength(0)

    // Closing the subscription flushes the pending window so the final state reaches the listener.
    unsubscribe()
    expect(emits).toHaveLength(1)
  })
})
