// A server with a window attached: a change main makes to its own layout (a CLI rename, create or
// close) reaches a subscribed phone's rows with no window publication after it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID
} from '../orca-runtime-test-fixtures.spec'
import {
  SURFACE_TAB_ID,
  surfaceRuntime
} from '../terminal/surface/terminal-surface-replies.test-fixture'
import { SECOND_TAB_ID, threeTabSurfaceRuntime } from './session-tabs-layout-moves.test-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

type Runtime = ReturnType<typeof surfaceRuntime>['runtime']

const rowOf = (leafId: string): string => `${SURFACE_TAB_ID}::${leafId}`

/** The window's one publication: both panes of the saved split, under their saved title. */
function windowPublication(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: rowOf(HEADLESS_LEAF_ID),
    activeTabType: 'terminal',
    tabs: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID].map((leafId) => ({
      type: 'terminal' as const,
      id: rowOf(leafId),
      title: 'Persisted Terminal',
      parentTabId: SURFACE_TAB_ID,
      leafId,
      isActive: leafId === HEADLESS_LEAF_ID
    }))
  }
}

/** Attaches a window that publishes once, then records every push a phone gets. */
async function windowedPhone(runtime: Runtime): Promise<RuntimeMobileSessionTabsResult[]> {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [windowPublication()] })
  await vi.runAllTimersAsync()
  const seen: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => {
    seen.push(snapshot)
  })
  return seen
}

const listed = (runtime: Runtime) => runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
const parentTabsOf = (
  rows: Pick<RuntimeMobileSessionTabsResult | RuntimeMobileSessionTabsSnapshot, 'tabs'> | undefined
): string[] => [
  ...new Set(
    (rows?.tabs ?? []).map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))
  )
]

/** The terminal tabs main's layout holds for the workspace, in saved order. */
function layoutTabIds(store: ReturnType<typeof surfaceRuntime>['store']): string[] {
  return (store.getSession().tabsByWorktree[TEST_WORKTREE_ID] ?? []).map((tab) => tab.id)
}

describe('session.tabs on a windowed server follow main without a window publish (switch on)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a CLI rename reaches the pushed and listed rows', async () => {
    const { runtime } = surfaceRuntime()
    const seen = await windowedPhone(runtime)

    await runtime.applyLayoutCommand({
      type: 'renameTab',
      workspace: TEST_WORKTREE_ID,
      tabId: SURFACE_TAB_ID,
      kind: 'custom',
      title: 'Build'
    })
    await vi.runAllTimersAsync()

    expect(seen.at(-1)?.tabs.map((tab) => tab.title)).toEqual(['Build', 'Build'])
    expect((await listed(runtime)).tabs.map((tab) => tab.title)).toEqual(['Build', 'Build'])
  })

  it('a CLI create reaches the pushed and listed rows', async () => {
    const { runtime, store } = surfaceRuntime()
    const seen = await windowedPhone(runtime)

    await runtime.applyLayoutCommand({
      type: 'createTerminalTab',
      workspace: TEST_WORKTREE_ID,
      tabId: SECOND_TAB_ID
    })
    await vi.runAllTimersAsync()

    expect(layoutTabIds(store)).toEqual([SURFACE_TAB_ID, SECOND_TAB_ID])
    expect(parentTabsOf(seen.at(-1))).toEqual([SURFACE_TAB_ID, SECOND_TAB_ID])
    expect(parentTabsOf(await listed(runtime))).toEqual([SURFACE_TAB_ID, SECOND_TAB_ID])
  })

  it("a CLI close reaches the rows, which then agree with main's layout", async () => {
    const { runtime, store } = threeTabSurfaceRuntime()
    const seen = await windowedPhone(runtime)
    expect(parentTabsOf(await listed(runtime))).toContain(SECOND_TAB_ID)

    await runtime.applyLayoutCommand({
      type: 'closeTabs',
      workspace: TEST_WORKTREE_ID,
      tabIds: [SECOND_TAB_ID],
      force: true
    })
    await vi.runAllTimersAsync()

    expect(layoutTabIds(store)).not.toContain(SECOND_TAB_ID)
    expect(parentTabsOf(seen.at(-1))).toEqual(layoutTabIds(store))
    expect(parentTabsOf(await listed(runtime))).toEqual(layoutTabIds(store))
  })

  it('a row main closed never comes back from an old snapshot a writer stores', async () => {
    const { runtime } = threeTabSurfaceRuntime()
    await windowedPhone(runtime)
    const before = runtime.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)
    if (!before) {
      throw new Error('the window published rows')
    }
    expect(parentTabsOf(before)).toContain(SECOND_TAB_ID)

    await runtime.applyLayoutCommand({
      type: 'closeTabs',
      workspace: TEST_WORKTREE_ID,
      tabIds: [SECOND_TAB_ID],
      force: true
    })
    await vi.runAllTimersAsync()
    // A main-side writer that rebuilt from rows held before the close.
    runtime.storeMobileSessionSnapshot(TEST_WORKTREE_ID, {
      ...before,
      snapshotVersion: before.snapshotVersion + 5
    })

    expect(parentTabsOf(await listed(runtime))).not.toContain(SECOND_TAB_ID)
  })
})
