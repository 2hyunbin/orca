// Phone-mirror parity (flip step 7) against main's projection: with the switch on, the rows a
// phone or paired desktop reads for a workspace main owns follow main's layout after a create, a
// close and a rename, even when the window's last publication still shows the old rows.
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID,
  TEST_WORKTREE_ID
} from '../orca-runtime-test-fixtures.spec'
import {
  SURFACE_TAB_ID,
  surfaceRuntime
} from '../terminal/surface/terminal-surface-replies.test-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const row = (leafId: string) => `${SURFACE_TAB_ID}::${leafId}`

/** The window's publication as it was before main's change: both panes, the old title. */
function stalePublication(version: number): RuntimeMobileSessionTabsSnapshot {
  const tabs = [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID].map((leafId) => ({
    type: 'terminal' as const,
    id: row(leafId),
    title: 'Persisted Terminal',
    parentTabId: SURFACE_TAB_ID,
    leafId,
    isActive: leafId === HEADLESS_LEAF_ID
  }))
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: row(HEADLESS_LEAF_ID),
    activeTabType: 'terminal',
    tabs
  }
}

async function phoneRows(runtime: ReturnType<typeof surfaceRuntime>['runtime']) {
  const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  return listed.tabs.map((tab) => ({ id: tab.id, title: tab.title }))
}

describe('session.tabs rows follow main’s layout (switch on)', () => {
  it('a pane main split in, and a pane main closed, before the window republished', async () => {
    const { runtime, store, setSession } = surfaceRuntime()
    runtime.attachWindow(1)
    const session = store.getSession()
    const layout = session.terminalLayoutsByTabId[SURFACE_TAB_ID]!
    setSession({
      ...session,
      terminalLayoutsByTabId: {
        [SURFACE_TAB_ID]: {
          ...layout,
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
            second: { type: 'leaf', leafId: HEADLESS_THIRD_LEAF_ID }
          }
        }
      }
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [stalePublication(1)] })

    const rows = await phoneRows(runtime)
    expect(rows.map((entry) => entry.id)).toEqual([
      row(HEADLESS_LEAF_ID),
      row(HEADLESS_THIRD_LEAF_ID)
    ])
  })

  it('a tab main renamed before the window republished', async () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [stalePublication(1)] })
    await runtime.applyLayoutCommand({
      type: 'renameTab',
      workspace: TEST_WORKTREE_ID,
      tabId: SURFACE_TAB_ID,
      kind: 'custom',
      title: 'Build'
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [stalePublication(2)] })

    const rows = await phoneRows(runtime)
    expect(rows.map((entry) => entry.title)).toEqual(['Build', 'Build'])
  })
})
