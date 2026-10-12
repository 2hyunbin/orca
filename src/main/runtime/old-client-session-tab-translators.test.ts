import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
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

  it('carries the retirement proof old desktops read after a pane leaves the layout', async () => {
    const split = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: 'pty-a',
      [HEADLESS_SECOND_LEAF_ID]: 'pty-b'
    })
    const { runtime } = headlessHost([terminalRow('split', 0, { ptyId: 'pty-a' })], {
      terminalLayoutsByTabId: { split }
    })
    runtime.registerPty('pty-a', TEST_WORKTREE_ID, null, {
      tabId: 'split',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.registerPty('pty-b', TEST_WORKTREE_ID, null, {
      tabId: 'split',
      leafId: HEADLESS_SECOND_LEAF_ID
    })
    const handle = (await runtime.listTerminals()).terminals.find(
      (terminal) => terminal.leafId === HEADLESS_SECOND_LEAF_ID
    )!.handle
    const closing = (await runtime.listMobileSessionTabs(WORKTREE)).tabs.find(
      (tab) => tab.type === 'terminal' && tab.leafId === HEADLESS_SECOND_LEAF_ID
    )!

    await runtime.closeMobileSessionTab(WORKTREE, closing.id)

    const listed = await runtime.listMobileSessionTabs(WORKTREE)
    expect(listed.tabs.map((tab) => tab.id)).not.toContain(closing.id)
    expect(listed.retiredTerminalSurfaces).toEqual([
      { parentTabId: 'split', leafId: HEADLESS_SECOND_LEAF_ID, ptyId: 'pty-b', terminal: handle }
    ])
  })

  it('opens a diff with no window and lists it as main does, across a reload', async () => {
    const { runtime, getSession, setSession } = headlessHost([terminalRow('first', 0)])
    const diffRow = {
      type: 'file',
      mode: 'diff',
      diffSource: 'staged',
      filePath: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      language: 'typescript',
      title: 'a.ts'
    }

    runtime.openHeldEditorFile(
      TEST_WORKTREE_ID,
      { filePath: '/repo/src/a.ts', relativePath: 'src/a.ts' },
      undefined,
      { staged: true }
    )
    expect((await runtime.listMobileSessionTabs(WORKTREE)).tabs).toContainEqual(
      expect.objectContaining(diffRow)
    )

    // Another writer's save reloads the holder; the unsaved view stays with its tab.
    setSession({ ...getSession() })
    expect((await runtime.listMobileSessionTabs(WORKTREE)).tabs).toContainEqual(
      expect.objectContaining(diffRow)
    )
  })
})

describe("the window's diff and markdown-preview rows while it keeps its own paths (until 6e)", () => {
  const DIFF_TAB = 'diff-tab'
  const PREVIEW_TAB = 'preview-tab'

  function windowSession() {
    const tab = (id: string, contentType: 'diff' | 'editor', sortOrder: number) => ({
      id,
      entityId: `${id}-file`,
      groupId: 'group',
      worktreeId: TEST_WORKTREE_ID,
      contentType,
      label: id,
      customLabel: null,
      color: null,
      sortOrder,
      createdAt: sortOrder + 1
    })
    return makeWorkspaceSessionWithHeadlessTerminal({
      unifiedTabs: {
        [TEST_WORKTREE_ID]: [tab(DIFF_TAB, 'diff', 0), tab(PREVIEW_TAB, 'editor', 1)]
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: DIFF_TAB,
            tabOrder: [DIFF_TAB, PREVIEW_TAB]
          }
        ]
      }
    })
  }

  const publishedRows: RuntimeMobileSessionTabsSnapshot = {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'window',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId: DIFF_TAB,
    activeTabType: 'file',
    tabs: [
      {
        type: 'file',
        id: DIFF_TAB,
        title: 'a.ts',
        filePath: '/repo/src/a.ts',
        relativePath: 'src/a.ts',
        language: 'typescript',
        mode: 'diff',
        diffSource: 'unstaged',
        isDirty: false,
        isActive: true
      },
      {
        type: 'markdown',
        id: PREVIEW_TAB,
        title: 'README.md',
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        language: 'markdown',
        mode: 'markdown-preview',
        isDirty: false,
        isActive: false,
        sourceFileId: 'source-file',
        sourceFilePath: '/repo/README.md',
        sourceRelativePath: 'README.md',
        documentVersion: 'file:source-file'
      }
    ]
  }

  const expectedRows = [
    expect.objectContaining({
      id: DIFF_TAB,
      type: 'file',
      mode: 'diff',
      diffSource: 'unstaged',
      filePath: '/repo/src/a.ts'
    }),
    expect.objectContaining({
      id: PREVIEW_TAB,
      type: 'markdown',
      mode: 'markdown-preview',
      filePath: '/repo/README.md',
      sourceFilePath: '/repo/README.md'
    })
  ]

  it('lists the rows the window publishes for tabs its session saved', async () => {
    const harness = makeRuntimeStoreWithWorkspaceSession(windowSession())
    const runtime = new OrcaRuntimeService(harness.runtimeStore)
    runtime.attachWindow(1)

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [publishedRows] })

    const listed = await runtime.listMobileSessionTabs(WORKTREE)
    expect(listed.tabs).toEqual(expect.arrayContaining(expectedRows))
  })

  it('lists them once the session save that adds their tabs lands after the rows', async () => {
    const harness = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
    const runtime = new OrcaRuntimeService(harness.runtimeStore)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [publishedRows] })

    harness.setSession(windowSession())
    await runtime.listMobileSessionTabs(WORKTREE)

    await vi.waitFor(async () =>
      expect((await runtime.listMobileSessionTabs(WORKTREE)).tabs).toEqual(
        expect.arrayContaining(expectedRows)
      )
    )
  })
})
