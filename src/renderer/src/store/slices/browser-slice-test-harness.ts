import { onTestFinished, vi, type Mock } from 'vitest'
import { create } from 'zustand'
import { createBrowserSlice } from './browser'
import type { AppState } from '../types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTabsGroupActions } from './tabs/tabs-group-actions'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

export type BrowserMockApi = {
  browser: {
    sessionListProfiles: Mock
    sessionCreateProfile: Mock
    sessionDeleteProfile: Mock
    sessionImportCookies: Mock
    sessionDetectBrowsers: Mock
    sessionDetectBrowsersForClientHost: Mock
    sessionImportFromBrowser: Mock
    sessionImportFromBrowserForClientHost: Mock
    sessionClearDefaultCookies: Mock
    notifyActiveTabChanged: Mock
  }
  runtimeEnvironments: { call: Mock }
}

export function createBrowserMockApi(runtimeEnvironmentTransportCall: Mock): BrowserMockApi {
  return {
    browser: {
      sessionListProfiles: vi.fn().mockResolvedValue([]),
      sessionCreateProfile: vi.fn().mockResolvedValue(null),
      sessionDeleteProfile: vi.fn().mockResolvedValue(false),
      sessionImportCookies: vi.fn().mockResolvedValue({ ok: false, reason: 'canceled' }),
      sessionDetectBrowsers: vi.fn().mockResolvedValue([]),
      // Why: null means this desktop hosts no pages for the server, so the RPC path runs.
      sessionDetectBrowsersForClientHost: vi.fn().mockResolvedValue(null),
      sessionImportFromBrowser: vi.fn().mockResolvedValue({ ok: false, reason: 'canceled' }),
      // Why: null means this desktop hosts no pages for the server, so the RPC path runs.
      sessionImportFromBrowserForClientHost: vi.fn().mockResolvedValue(null),
      sessionClearDefaultCookies: vi.fn().mockResolvedValue(false),
      notifyActiveTabChanged: vi.fn().mockResolvedValue(undefined)
    },
    runtimeEnvironments: {
      call: runtimeEnvironmentTransportCall
    }
  }
}

export function createTestStore() {
  return create<AppState>()(
    (...a) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial store; browser actions touch only the fields seeded here.
      ({
        settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
        activeWorktreeId: 'wt-1',
        browserDefaultUrl: 'about:blank',
        unifiedTabsByWorktree: {},
        groupsByWorktree: {},
        tabBarOrderByWorktree: {},
        tabsByWorktree: {},
        openFiles: [],
        activeTabType: 'terminal',
        activeTabTypeByWorktree: {},
        worktreesByRepo: {},
        createUnifiedTab: vi.fn(),
        closeUnifiedTab: vi.fn(),
        activateTab: vi.fn(),
        setTabLabel: vi.fn(),
        recordFeatureInteraction: vi.fn(),
        ...createBrowserSlice(...a)
      }) as unknown as AppState
  )
}

export type BrowserTestStore = ReturnType<typeof createTestStore>

/** A worktree's one empty pane group, which main places an open in; it replaces wt-1's. */
export function onePaneGroup(worktreeId: string, groupId = 'group-1'): Partial<AppState> {
  return {
    groupsByWorktree: {
      [worktreeId]: [{ id: groupId, worktreeId, activeTabId: null, tabOrder: [] }]
    },
    layoutByWorktree: { [worktreeId]: { type: 'leaf', groupId } },
    activeGroupIdByWorktree: { [worktreeId]: groupId }
  }
}

/** wt-1's pane group, plus the slices a session payload reads that the partial store lacks. */
const DRAWN_STORE_SEED: Partial<AppState> = {
  repos: [],
  editorDrafts: {},
  markdownFrontmatterVisible: {},
  activeFileIdByWorktree: {},
  workspaceDocHistory: [],
  lastVisitedAtByWorktreeId: {},
  defaultTerminalTabsAppliedByWorktreeId: {},
  ...onePaneGroup('wt-1')
}

/**
 * The partial store with main drawing its tabs (switch-on): seeded first, since main loads the
 * layout the store holds now. The test file installs the layout-apply transport (see
 * tabs-drawn-from-main.test-fixture.ts); main closes when the test finishes.
 */
export async function createTestStoreDrawnFromMain(
  seed?: Partial<AppState>
): Promise<{ store: BrowserTestStore; main: TabsDrawnFromMain }> {
  const store = createTestStore()
  // Main drops a workspace with its last tab; the next open places through the real root group.
  const { ensureWorktreeRootGroup, focusGroup } = createTabsGroupActions(
    store.setState,
    store.getState
  )
  store.setState({ ...DRAWN_STORE_SEED, ensureWorktreeRootGroup, focusGroup, ...seed })
  const main = await drawTabsFromMain(store)
  onTestFinished(() => main.close())
  return { store, main }
}

export function settingsWithRuntime(id: string): AppState['settings'] {
  return { activeRuntimeEnvironmentId: id } as AppState['settings']
}

export function runtimeStatuses(capabilities: string[]): AppState['runtimeStatusByEnvironmentId'] {
  return new Map([
    [
      'env-1',
      {
        status: { capabilities },
        checkedAt: 1
      }
    ]
  ]) as AppState['runtimeStatusByEnvironmentId']
}

/** Mirrors the runtime-guard beforeEach: full mock reset plus the RPC transport bridge. */
export function resetBrowserRuntimeMocks(mocks: {
  runtimeEnvironmentCall: Mock
  runtimeEnvironmentTransportCall: Mock
  createWebRuntimeSessionBrowserTabMock: Mock
}): void {
  const { runtimeEnvironmentCall, runtimeEnvironmentTransportCall } = mocks
  vi.clearAllMocks()
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  mocks.createWebRuntimeSessionBrowserTabMock.mockReset()
  mocks.createWebRuntimeSessionBrowserTabMock.mockResolvedValue(true)
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  runtimeEnvironmentCall.mockResolvedValue({ id: 'rpc-1', ok: true, result: {} })
}
