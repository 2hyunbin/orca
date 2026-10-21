import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import { TEST_WORKTREE_ID } from '../orca-runtime-test-fixtures.spec'
import { SURFACE_TAB_ID } from '../terminal/surface/terminal-surface-replies.test-fixture'
import { threeTabSurfaceRuntime } from './session-tabs-layout-moves.test-fixture'
vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
describe('x', () => {
  it('x', async () => {
    vi.useFakeTimers()
    const { runtime, store, setSession } = threeTabSurfaceRuntime()
    const session = store.getSession()
    const all = session.tabsByWorktree[TEST_WORKTREE_ID]!; const first = all[0]
    setSession({ ...session, tabsByWorktree: { [TEST_WORKTREE_ID]: [...all, { ...first!, id: 'serve-tab', ptyId: 'serve-1', sortOrder: 1, createdAt: 3 }] } })
    runtime.registerPty('serve-1', TEST_WORKTREE_ID, null, { tabId: 'serve-tab', leafId: 'pane:1' } as never)
    runtime.registerPty('serve-2', TEST_WORKTREE_ID, null, { tabId: '99999999-9999-4999-8999-999999999999', leafId: '12121212-1212-4212-8212-121212121212' } as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await vi.runAllTimersAsync()
    let pushes = 0
    runtime.onMobileSessionTabsChanged(() => { pushes++ })
    const a = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    await vi.runAllTimersAsync()
    const b = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    await vi.runAllTimersAsync()
    const c = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    await vi.runAllTimersAsync()
    console.log(JSON.stringify({ a: a.snapshotVersion, b: b.snapshotVersion, c: c.snapshotVersion, pushes, rows: c.tabs.map((t) => [t.id, (t as {ptyId?: string}).ptyId]), groups: c.tabGroups, saved: Object.keys(store.getSession().terminalLayoutsByTabId), surface: SURFACE_TAB_ID }))
    vi.useRealTimers()
    expect(1).toBe(1)
  })
})
