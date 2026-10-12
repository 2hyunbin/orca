import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
/**
 * A PTY's title change or exit reads only the worktree whose pane binds it (found through the held
 * model, not by projecting every worktree), and toggling generated titles re-emits every worktree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const COUNT = 30
const wt = (index: number): string => `repo-1::/tmp/worktree-${index}`
const leaf = (index: number): string => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`

const repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}

/** One single-pane terminal tab per worktree, bound to `pty-<index>`. */
function session(): WorkspaceSessionState {
  const indexes = [...Array(COUNT).keys()]
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: wt(0),
    activeTabId: null,
    tabsByWorktree: Object.fromEntries(
      indexes.map((index) => [
        wt(index),
        [
          {
            id: `tab-${index}`,
            ptyId: `pty-${index}`,
            worktreeId: wt(index),
            title: 'zsh',
            generatedTitle: 'Fix the build',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      ])
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      indexes.map((index) => [
        `tab-${index}`,
        {
          root: { type: 'leaf', leafId: leaf(index) },
          activeLeafId: leaf(index),
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf(index)]: `pty-${index}` }
        }
      ])
    )
  }
}

function createRuntime() {
  let current = session()
  const settings = { tabAutoGenerateTitle: false }
  const settingsListeners = new Set<
    (updates: Partial<GlobalSettings>, next: GlobalSettings) => void
  >()
  const store = {
    getRepo: () => repo,
    getRepos: () => [repo],
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
      ...settings
    }),
    onSettingsChanged: (
      listener: (updates: Partial<GlobalSettings>, next: GlobalSettings) => void
    ) => {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    },
    getWorkspaceSession: () => current,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      current = next
    },
    getWorkspaceSessionHostIds: (): ExecutionHostId[] => [LOCAL_EXECUTION_HOST_ID]
  }
  const runtime = new OrcaRuntimeService(store)
  /** What the settings IPC does: write the setting, then notify listeners. */
  const setGeneratedTitles = (enabled: boolean): void => {
    settings.tabAutoGenerateTitle = enabled
    for (const listener of settingsListeners) {
      listener(
        { tabAutoGenerateTitle: enabled },
        { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: enabled }
      )
    }
  }
  const projected = vi.spyOn(runtime['sessionTabsStream'], 'snapshot')
  return { runtime, setGeneratedTitles, projected }
}

describe('session.tabs PTY lookup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('projects nothing on a title change with no phone, and only the bound worktree with one', () => {
    const { runtime, projected } = createRuntime()
    const versionOf = (index: number): number =>
      runtime['getMobileSessionTabsForWorktree'](wt(index)).snapshotVersion
    const before = versionOf(7)
    projected.mockClear()

    runtime['touchMobileSessionSnapshotsForPty']('pty-7')
    vi.advanceTimersByTime(1_000)
    expect(projected).not.toHaveBeenCalled()
    // A list-only client still sees a newer version for the worktree that changed.
    expect(versionOf(7)).toBeGreaterThan(before)

    const frames: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => frames.push(snapshot))
    projected.mockClear()
    runtime['touchMobileSessionSnapshotsForPty']('pty-7')
    vi.advanceTimersByTime(1_000)
    expect(frames.map((frame) => frame.worktree)).toEqual([wt(7)])
    expect(new Set(projected.mock.calls.map(([worktreeId]) => worktreeId))).toEqual(
      new Set([wt(7)])
    )
  })

  it('retires an exited pane, with no phone, reading only its own worktree', async () => {
    const { runtime, projected } = createRuntime()
    projected.mockClear()

    await runtime.onPtyExit('pty-7', 0, undefined, { providerExitObserved: true })

    expect(new Set(projected.mock.calls.map(([worktreeId]) => worktreeId))).toEqual(
      new Set([wt(7)])
    )
    expect(runtime['getMobileSessionTabsForWorktree'](wt(7)).tabs).toEqual([])
    expect(runtime['getMobileSessionTabsForWorktree'](wt(8)).tabs).toHaveLength(1)
  })
})

describe('the generated-titles setting', () => {
  it('re-emits every worktree with the new titles when it is toggled', () => {
    const { runtime, setGeneratedTitles } = createRuntime()
    const frames: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => frames.push(snapshot))
    const before = runtime['getMobileSessionTabsForWorktree'](wt(0)).snapshotVersion
    expect(runtime['getMobileSessionTabsForWorktree'](wt(0)).tabs[0]).toMatchObject({
      title: 'zsh'
    })

    setGeneratedTitles(true)

    const worktrees = frames.map((frame) => frame.worktree)
    // Every listed worktree, the catalog's empty ones included.
    expect(worktrees).toEqual(expect.arrayContaining([...Array(COUNT).keys()].map(wt)))
    expect(new Set(worktrees).size).toBe(worktrees.length)
    const first = frames.find((frame) => frame.worktree === wt(0))!
    expect(first.snapshotVersion).toBeGreaterThan(before)
    expect(first.tabs[0]).toMatchObject({ title: 'Fix the build' })

    // A settings write that leaves the setting as it was emits nothing.
    frames.length = 0
    setGeneratedTitles(true)
    expect(frames).toEqual([])
  })
})
