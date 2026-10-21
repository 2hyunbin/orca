// Runs on plain Node, as orcad does: main's "Hide sleeping" retention reads the runtime's own facts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeStore } from '../runtime-store-contract'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const repo = { id: 'repo-1', path: '/r', displayName: 'r', badgeColor: 'blue', addedAt: 1 }
const WT = 'repo-1::/r/a'
// The key main lists WT's row under; retention names rows by it.
const ROW_KEY = composeWorktreeHostIdentity(undefined, WT)
const LEAF = '22222222-2222-4222-8222-222222222222'

function worktree(id: string): ResolvedWorktree {
  return {
    id,
    repoId: repo.id,
    path: id,
    branch: 'a',
    head: '',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path: id, head: '', branch: 'a', isBare: false, isMainWorktree: false }
  }
}

class Probe extends OrcaRuntimeService {
  protected override async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
    return { worktrees: [worktree(WT)], platformByRepoId: new Map() }
  }
}

type Host = NonNullable<OrcaRuntimeService['sidebarFacts']>

/** The window's graph: one terminal tab in WT, running pty-1. */
function publishTerminalTab(runtime: Host): void {
  runtime.syncWindowGraph(1, {
    tabs: [{ tabId: 'tab-1', worktreeId: WT, title: 'Terminal', activeLeafId: LEAF, layout: null }],
    leaves: [{ tabId: 'tab-1', worktreeId: WT, leafId: LEAF, paneRuntimeId: 1, ptyId: 'pty-1' }],
    mobileSessionTabs: [
      {
        worktree: WT,
        publicationEpoch: 'renderer:test',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [
          {
            type: 'terminal',
            id: `tab-1::${LEAF}`,
            parentTabId: 'tab-1',
            leafId: LEAF,
            title: 'Terminal',
            ptyId: 'pty-1',
            isActive: true
          }
        ]
      }
    ]
  })
}

/** A window with one terminal open in WT, its list mounted, "Hide sleeping" on. */
async function createHost(): Promise<Host> {
  const store: Pick<RuntimeStore, 'getRepos' | 'getUI'> = {
    getRepos: () => [repo],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only hideSleepingWorkspaces.
    getUI: () => ({ hideSleepingWorkspaces: true }) as PersistedUIState
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths touch only repos and the UI flag.
  const runtime = new Probe(store as RuntimeStore).sidebarFacts
  if (!runtime) {
    throw new Error('built without the sidebar facts layer')
  }
  publishTerminalTab(runtime)
  runtime.beginSidebarListSession('session-1')
  await vi.advanceTimersByTimeAsync(300)
  expect(runtime.getWorkspaceActivityFacts().facts[WT]?.terminal).toBe('live')
  return runtime
}

// As the window's sleep does (pty:kill with keepHistory): a reversible stop keeps the tab.
function stopTerminalKeepingTab(runtime: Host): void {
  const settle = runtime.intentionalPtyStops.mark('pty-1', 'reversible', null)
  runtime.onPtyExit('pty-1', 0)
  settle(true)
  expect(runtime.getWorkspaceActivityFacts().facts[WT]).toBeUndefined()
}

const retained = (runtime: Host): readonly string[] =>
  runtime.getSidebarTemporalSnapshot().retention?.retainedIds ?? []

describe('main sleeping retention and a window sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a row through an unexplained terminal gap', async () => {
    const runtime = await createHost()
    stopTerminalKeepingTab(runtime)
    expect(retained(runtime)).toEqual([ROW_KEY])
  })

  it('drops the row in the same pass when the window slept the workspace', async () => {
    const runtime = await createHost()
    runtime.noteWindowSleptWorkspaces('window-1', [WT])
    stopTerminalKeepingTab(runtime)
    expect(retained(runtime)).toEqual([])
  })

  it('ends a grace already open when the sleep is reported after the exit', async () => {
    const runtime = await createHost()
    stopTerminalKeepingTab(runtime)
    expect(retained(runtime)).toEqual([ROW_KEY])
    runtime.noteWindowSleptWorkspaces('window-1', [WT])
    expect(retained(runtime)).toEqual([])
  })

  it('forgets a window’s sleeps when its connection closes', async () => {
    const runtime = await createHost()
    runtime.noteWindowSleptWorkspaces('window-1', [WT])
    runtime.cleanupSubscriptionsForConnection('window-1')
    stopTerminalKeepingTab(runtime)
    expect(retained(runtime)).toEqual([ROW_KEY])
  })
})

/** The window's graph once its terminal tab in WT is closed. */
function publishNoTabs(runtime: Host): void {
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: WT,
        publicationEpoch: 'renderer:test',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    ]
  })
}

// pty-1 is recorded as the spawn records it, so it reads live until its exit arrives.
async function createHostWithSpawnedPty(): Promise<Host> {
  const runtime = await createHost()
  runtime.registerPty('pty-1', WT)
  return runtime
}

describe('main sleeping retention and a closed last tab', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops the row as the window closes the tab, before the terminal exits', async () => {
    const runtime = await createHostWithSpawnedPty()
    // As closeTab does: pty:kill first, then the graph without the tab.
    runtime.markPtyStopRequested('pty-1')
    expect(runtime.getWorkspaceActivityFacts().facts[WT]?.terminal).toBe('live')
    publishNoTabs(runtime)
    expect(runtime.getWorkspaceActivityFacts().facts[WT]).toBeUndefined()
    expect(retained(runtime)).toEqual([])
  })

  it('drops the row when the stop request lands after the graph', async () => {
    const runtime = await createHostWithSpawnedPty()
    publishNoTabs(runtime)
    expect(runtime.getWorkspaceActivityFacts().facts[WT]?.terminal).toBe('live')
    runtime.markPtyStopRequested('pty-1')
    expect(runtime.getWorkspaceActivityFacts().facts[WT]).toBeUndefined()
    expect(retained(runtime)).toEqual([])
  })

  it('keeps a terminal live while a pane still shows it, though asked to stop', async () => {
    const runtime = await createHostWithSpawnedPty()
    runtime.markPtyStopRequested('pty-1')
    await vi.advanceTimersByTimeAsync(300)
    expect(runtime.getWorkspaceActivityFacts().facts[WT]?.terminal).toBe('live')
  })

  it('keeps a closed tab’s terminal unverifiable when its host stops answering', async () => {
    const runtime = await createHostWithSpawnedPty()
    runtime.markPtyStopRequested('pty-1')
    publishNoTabs(runtime)
    runtime.markPtyLivenessUnverifiable('pty-1', 'ssh contact lost')
    expect(runtime.getWorkspaceActivityFacts().facts[WT]?.terminal).toBe('unverifiable')
  })

  it('counts the terminal live again when its stop fails', async () => {
    const runtime = await createHostWithSpawnedPty()
    runtime.markPtyStopRequested('pty-1')
    publishNoTabs(runtime)
    expect(runtime.getWorkspaceActivityFacts().facts[WT]).toBeUndefined()
    runtime.clearPtyStopRequest('pty-1')
    expect(runtime.getWorkspaceActivityFacts().facts[WT]?.terminal).toBe('live')
  })
})
