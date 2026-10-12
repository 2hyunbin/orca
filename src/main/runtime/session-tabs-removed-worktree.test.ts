import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
/**
 * A removed worktree leaves `session.tabs` for good: phones get its removed frame, `listAll` no
 * longer lists it, and a later Store write (the reload bridge) does not republish it as empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'
const OTHER = 'repo-1::/tmp/worktree-b'
const LEAF_BY_WORKTREE: Record<string, string> = {
  [WT]: '11111111-1111-4111-8111-111111111111',
  [OTHER]: '22222222-2222-4222-8222-222222222222'
}

const repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}

/** One single-pane terminal tab per worktree. */
function sessionWith(worktreeIds: string[]): WorkspaceSessionState {
  const tabId = (worktreeId: string): string => `tab-${LEAF_BY_WORKTREE[worktreeId]}`
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: Object.fromEntries(
      worktreeIds.map((worktreeId) => [
        worktreeId,
        [
          {
            id: tabId(worktreeId),
            ptyId: null,
            worktreeId,
            title: 'zsh',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      ])
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      worktreeIds.map((worktreeId) => {
        const leafId = LEAF_BY_WORKTREE[worktreeId]!
        return [
          tabId(worktreeId),
          { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
        ]
      })
    )
  }
}

function createRuntime() {
  let session = sessionWith([WT, OTHER])
  const written = new Set<() => void>()
  /** Another writer writes the Store, which announces it. */
  const writeSession = (next: WorkspaceSessionState): void => {
    session = next
    for (const listener of written) {
      listener()
    }
  }
  const store = {
    getRepo: () => repo,
    getRepos: () => [repo],
    addRepo: () => {},
    updateRepo: () => undefined as never,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    setWorktreeMeta: () => undefined as never,
    // As the Store does: removing the worktree purges its session rows.
    removeWorktreeMeta: (worktreeId: string) =>
      writeSession(sessionWith([WT, OTHER].filter((id) => id !== worktreeId))),
    getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
    addRetiredWorktreeName: () => {},
    mergeRetiredWorktreeNames: () => false,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    getWorkspaceSessionHostIds: (): ExecutionHostId[] => [LOCAL_EXECUTION_HOST_ID],
    onWorkspaceSessionWritten: (listener: () => void) => {
      written.add(listener)
      return () => written.delete(listener)
    }
  }
  const runtime = new OrcaRuntimeService(store)
  // Both worktrees are in the local catalog, as a scan lists them.
  runtime.addCatalogWorkspaces([WT, OTHER])
  const frames: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => frames.push(snapshot))
  return { runtime, store, frames, writeSession, current: () => session }
}

describe('a removed worktree in session.tabs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends one removed frame, leaves listAll, and stays gone after a later Store write', async () => {
    const { runtime, store, frames, writeSession, current } = createRuntime()
    const listedIds = async () =>
      (await runtime.listAllMobileSessionTabs()).map((snapshot) => snapshot.worktree)
    expect(await listedIds()).toEqual(expect.arrayContaining([WT, OTHER]))
    frames.length = 0

    runtime['removeWorktreeMetadataAndHistory'](store, WT)
    // A later Store write the reload bridge picks up, later emits (a terminal's title, a
    // page), and any coalesced notify settling.
    writeSession({ ...current(), activeWorktreeId: OTHER })
    runtime.notifyMobileSessionTabsChanged(WT)
    runtime.notifyMobileSessionTabsChanged()
    runtime.touchMobileSessionTabsForWorktree(WT)
    vi.advanceTimersByTime(1_000)

    const forRemoved = frames.filter((frame) => frame.worktree === WT)
    expect(forRemoved).toEqual([expect.objectContaining({ worktree: WT, removed: true })])
    expect(await listedIds()).not.toContain(WT)
    expect(await listedIds()).toContain(OTHER)
    expect(runtime['getMobileSessionTabsForWorktree'](WT).tabs).toEqual([])
  })
})
