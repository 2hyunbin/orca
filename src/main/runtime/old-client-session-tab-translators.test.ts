import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

const WORKTREE = `id:${TEST_WORKTREE_ID}`

function terminalRow(id: string, sortOrder: number, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: TEST_WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1,
    ...extra
  }
}

/** A host with no window: old clients' methods are translated into layout commands. */
function headlessHost(tabs: TerminalTab[], layouts = {}) {
  const harness = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: { [TEST_WORKTREE_ID]: tabs },
      terminalLayoutsByTabId: Object.fromEntries(
        tabs.map((tab) => [tab.id, makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })])
      ),
      ...layouts
    })
  )
  return { ...harness, runtime: new OrcaRuntimeService(harness.runtimeStore) }
}

describe("old clients' session-tab methods on a host with no window", () => {
  it('refuses closing a pinned tab with the old code, and closes it when forced', async () => {
    const { runtime, getSession } = headlessHost([terminalRow('pinned', 0, { isPinned: true })])

    await expect(runtime.closeMobileSessionTab(WORKTREE, 'pinned')).rejects.toThrow(
      'terminal_tab_pinned'
    )
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['pinned'])

    await runtime.closeMobileSessionTab(WORKTREE, 'pinned', { force: true })
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID] ?? []).toEqual([])
  })

  it('applies a pane-ratio change and reports a structure change as not updated', async () => {
    const split = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: undefined,
      [HEADLESS_SECOND_LEAF_ID]: undefined
    })
    const { runtime, getSession } = headlessHost([terminalRow('split', 0)], {
      terminalLayoutsByTabId: { split }
    })
    const resized = { ...split.root!, ratio: 0.3 }

    await expect(
      runtime.updateMobileSessionPaneLayout(WORKTREE, {
        tabId: 'split',
        root: resized,
        expandedLeafId: null
      })
    ).resolves.toEqual({ updated: true })
    expect(getSession().terminalLayoutsByTabId.split?.root).toMatchObject({ ratio: 0.3 })

    // Collapsing the split is not one of rule 11's commands, so it changes nothing.
    await expect(
      runtime.updateMobileSessionPaneLayout(WORKTREE, {
        tabId: 'split',
        root: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
        expandedLeafId: null
      })
    ).resolves.toEqual({ updated: false })
    expect(getSession().terminalLayoutsByTabId.split?.root).toMatchObject({ type: 'split' })
  })

  it("selects a moved tab in the sender's view only", async () => {
    const { runtime } = headlessHost([terminalRow('first', 0), terminalRow('second', 1)])
    const before = await runtime.listMobileSessionTabs(WORKTREE)
    const group = before.tabGroups![0]!
    const moving = before.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'second'
    )!

    await runtime.moveMobileSessionTab(
      WORKTREE,
      {
        kind: 'reorder',
        tabId: moving.id,
        targetGroupId: group.id,
        tabOrder: group.tabOrder.toReversed()
      },
      { clientNavigationId: 'phone-a' }
    )

    const sender = await runtime.listMobileSessionTabs(WORKTREE, 'phone-a')
    const observer = await runtime.listMobileSessionTabs(WORKTREE)
    expect(sender.tabGroups![0]!.tabOrder).toEqual(group.tabOrder.toReversed())
    expect(sender.activeTabId).toBe(moving.id)
    expect(observer.activeTabId).toBe(before.activeTabId)
  })

  it("keeps a user's rename over the terminal's live title (#19582)", async () => {
    const { runtime } = headlessHost(
      [terminalRow('renamed', 0, { ptyId: 'pty-renamed', customTitle: 'Deploy watcher' })],
      {
        terminalLayoutsByTabId: {
          renamed: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'pty-renamed' })
        }
      }
    )
    runtime.registerPty('pty-renamed', TEST_WORKTREE_ID, null, {
      tabId: 'renamed',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyData('pty-renamed', '\x1b]0;claude working\x07', 1)

    const listed = await runtime.listMobileSessionTabs(WORKTREE)
    expect(listed.tabs[0]).toMatchObject({ type: 'terminal', title: 'Deploy watcher' })
  })
})
