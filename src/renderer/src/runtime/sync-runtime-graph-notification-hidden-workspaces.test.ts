import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './sync-runtime-graph'
import type { AppState } from '../store/types'
import { getDefaultSettings } from '../../../shared/constants'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import { makeWorktree, TEST_REPO } from '../store/slices/worktrees-slice-test-fixtures'

vi.mock('./sync-runtime-graph/terminal-group-grid-sizes', () => ({
  measureTerminalGroupGridSizes: () => undefined
}))

const CLI_ID = 'repo1::/cli'

function stateWith(hideCliCreatedWorkspaces: boolean, notifyHiddenWorkspaces = false) {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {},
    repos: [TEST_REPO],
    projects: [],
    projectHostSetups: [],
    projectOrderBy: 'recent',
    settings: {
      ...getDefaultSettings('/tmp'),
      notifications: { ...getDefaultNotificationSettings(), notifyHiddenWorkspaces }
    },
    persistedUIReady: true,
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: CLI_ID,
          repoId: 'repo1',
          path: '/cli',
          cliProvenance: { kind: 'created-by-cli', createdAt: 0 }
        })
      ]
    },
    folderWorkspaces: [],
    worktreeLineageById: {},
    sortBy: 'recent',
    showSleepingWorkspaces: true,
    filterRepoIds: [],
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: null,
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: true,
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: {}
  }
}

async function flushSync(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20)
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the notification-hidden workspaces in the window graph', () => {
  it('carries the whole set on first sync and on each change, and nothing while unchanged', async () => {
    const syncWindowGraph = vi
      .fn<(graph: RuntimeSyncWindowGraph) => Promise<object>>()
      .mockResolvedValue({})
    vi.useFakeTimers()
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    let state = stateWith(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: graph sync and the hidden set read only these members of the store.
    setRuntimeGraphStoreStateGetter(() => state as unknown as AppState)
    setRuntimeGraphSyncEnabled(true)
    await flushSync()
    const published = () =>
      syncWindowGraph.mock.calls.map(([graph]) => graph.notificationHiddenWorkspaceKeys)
    expect(published()).toEqual([[CLI_ID]])

    // Same content under new input identities is not a change.
    state = stateWith(true)
    scheduleRuntimeGraphSync()
    await flushSync()
    expect(published()).toEqual([[CLI_ID], undefined])

    // Opting in empties the set, and the empty set is sent so main stops hiding.
    state = stateWith(true, true)
    scheduleRuntimeGraphSync()
    await flushSync()
    expect(published()).toEqual([[CLI_ID], undefined, []])

    state = stateWith(true)
    scheduleRuntimeGraphSync()
    await flushSync()
    expect(published()).toEqual([[CLI_ID], undefined, [], [CLI_ID]])
  })
})
