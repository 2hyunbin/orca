/**
 * The phone list is a projection of the Store-held session: what the Store holds is listed, Store
 * writes reach subscribers through the coalescer with a version clients accept, and window graph
 * syncs that change nothing a phone shows emit nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult,
  RuntimeSyncedLeaf
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

// Freshness predicate of shouldApplyWebSessionTabsSnapshot in
// src/renderer/src/runtime/web-session-tabs-sync.ts, copied as a literal
// because a main-process test must not import a renderer module: a same-epoch
// frame whose version is not strictly newer is dropped by web clients.
function makeWebClientFreshnessGate(): (frame: RuntimeMobileSessionTabsResult) => boolean {
  const latestByWorktree = new Map<string, { publicationEpoch: string; snapshotVersion: number }>()
  return (frame) => {
    const current = latestByWorktree.get(frame.worktree)
    if (
      current &&
      current.publicationEpoch === frame.publicationEpoch &&
      frame.snapshotVersion <= current.snapshotVersion
    ) {
      return false
    }
    latestByWorktree.set(frame.worktree, {
      publicationEpoch: frame.publicationEpoch,
      snapshotVersion: frame.snapshotVersion
    })
    return true
  }
}

const WT = 'repo-1::/tmp/worktree-a'
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
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
    branchPrefixCustom: ''
  })
}

function makeSession(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

function makeTerminalTab(id: string, ptyId: string | null) {
  return {
    id,
    ptyId,
    worktreeId: WT,
    title: `Terminal ${id}`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** One terminal tab per entry, each a single leaf bound to its saved ptyId (or unbound). */
function sessionWithTerminals(
  terminals: { tabId: string; leafId: string; ptyId: string | null }[]
): WorkspaceSessionState {
  return makeSession({
    tabsByWorktree: { [WT]: terminals.map(({ tabId, ptyId }) => makeTerminalTab(tabId, ptyId)) },
    terminalLayoutsByTabId: Object.fromEntries(
      terminals.map(({ tabId, leafId, ptyId }) => [
        tabId,
        {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ...(ptyId ? { ptyIdsByLeafId: { [leafId]: ptyId } } : {})
        }
      ])
    )
  })
}

function createRuntime(initialSession: WorkspaceSessionState) {
  let session = initialSession
  const written = new Set<() => void>()
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    getWorkspaceSessionHostIds: () => ['local'],
    onWorkspaceSessionWritten: (listener: () => void) => {
      written.add(listener)
      return () => written.delete(listener)
    }
  })
  const events: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
  /** Another writer (the window's session save) writes the Store, which announces it. */
  const writeSession = (next: WorkspaceSessionState): void => {
    session = next
    for (const listener of written) {
      listener()
    }
  }
  const sync = (leaves: RuntimeSyncedLeaf[] = []): void => {
    runtime.syncWindowGraph(1, { tabs: [], leaves })
  }
  const list = () => runtime.listMobileSessionTabs(`id:${WT}`)
  return { runtime, events, sync, writeSession, list }
}

describe('graph-sync mobile snapshot gating', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists a serve-owned terminal bound via tab.ptyId', async () => {
    const { list } = createRuntime(
      makeSession({ tabsByWorktree: { [WT]: [makeTerminalTab('serve-tab', 'serve-pty-1')] } })
    )

    expect((await list()).tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'serve-tab' })
    ])
  })

  it('lists a serve-owned terminal bound ONLY via the layout leaf map', async () => {
    const { list } = createRuntime(
      sessionWithTerminals([{ tabId: 'split-tab', leafId: LEAF_1, ptyId: 'serve-pty-2' }])
    )

    expect((await list()).tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'split-tab',
        parentLayout: expect.objectContaining({ ptyIdsByLeafId: { [LEAF_1]: 'serve-pty-2' } })
      })
    ])
  })

  it('emits nothing for repeated graph syncs that change nothing a phone shows', () => {
    const { events, sync } = createRuntime(
      sessionWithTerminals([{ tabId: 'serve-tab', leafId: LEAF_1, ptyId: 'serve-pty-1' }])
    )
    sync()
    vi.advanceTimersByTime(300)
    events.length = 0

    for (let i = 0; i < 5; i++) {
      sync()
    }
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
  })

  it('emits ready when a graph-only sync binds a restored leaf', () => {
    const { events, sync } = createRuntime(
      sessionWithTerminals([{ tabId: 'tab-1', leafId: LEAF_1, ptyId: 'pty-restored' }])
    )
    const webClientAccepts = makeWebClientFreshnessGate()
    // Renderer restore: the saved layout names the PTY, but the graph leaf has not re-bound yet.
    const nullLeaf = {
      tabId: 'tab-1',
      worktreeId: WT,
      leafId: LEAF_1,
      paneRuntimeId: 1,
      ptyId: null
    }
    sync([nullLeaf])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    expect(webClientAccepts(events[0]!)).toBe(true)

    // A later graph-only sync binds the leaf: the payload depends on leaf state too.
    events.length = 0
    sync([{ ...nullLeaf, ptyId: 'pty-restored' }])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toMatchObject({
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
    // The web freshness gate drops same-epoch frames that are not strictly newer.
    expect(webClientAccepts(events[0]!)).toBe(true)

    events.length = 0
    sync([{ ...nullLeaf, ptyId: 'pty-restored' }])
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
  })

  it('delivers a desktop close as a frame clients accept, keeping the other tab', async () => {
    const both = sessionWithTerminals([
      { tabId: 'tab-a', leafId: LEAF_1, ptyId: null },
      { tabId: 'serve-tab', leafId: LEAF_2, ptyId: 'serve-pty-1' }
    ])
    const { events, writeSession, list } = createRuntime(both)
    const webClientAccepts = makeWebClientFreshnessGate()
    expect(webClientAccepts(await list())).toBe(true)

    writeSession(
      sessionWithTerminals([{ tabId: 'serve-tab', leafId: LEAF_2, ptyId: 'serve-pty-1' }])
    )
    vi.advanceTimersByTime(60)

    expect(events).toHaveLength(1)
    expect(events[0]?.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'serve-tab' })
    ])
    expect(webClientAccepts(events[0]!)).toBe(true)
  })

  it('emits a removed frame immediately when the Store drops the worktree', async () => {
    const { events, writeSession, list } = createRuntime(
      sessionWithTerminals([{ tabId: 'tab-1', leafId: LEAF_1, ptyId: null }])
    )
    expect((await list()).tabs).toHaveLength(1)

    writeSession(makeSession())

    expect(events).toEqual([
      expect.objectContaining({
        worktree: WT,
        removed: true
      } satisfies Partial<RuntimeMobileSessionTabsRemovedResult>)
    ])
    events.length = 0
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
  })

  it('drains a pending notify to existing subscribers instead of replaying it to a new one', () => {
    const { runtime, events } = createRuntime(
      sessionWithTerminals([{ tabId: 'tab-1', leafId: LEAF_1, ptyId: 'pty-1' }])
    )
    // touchMobileSessionSnapshotsForPty is protected; it is what a title change calls.
    runtime['touchMobileSessionSnapshotsForPty']('pty-1')
    vi.advanceTimersByTime(20)
    expect(events).toHaveLength(0)

    const lateEvents: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => lateEvents.push(snapshot))
    const drainedOnSubscribe = events.length

    vi.advanceTimersByTime(500)
    // The new subscriber's initial snapshot already holds that state.
    expect(lateEvents).toEqual([])
    expect(drainedOnSubscribe).toBe(1)
    expect(events).toHaveLength(1)
  })
})
