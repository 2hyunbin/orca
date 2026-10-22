import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'

// #29968: on a host with no window a chat tab lives only in the runtime's snapshot; rebuilding that
// snapshot from the saved terminals and editors must not drop it.
const WORKTREE = `id:${TEST_WORKTREE_ID}`
const README = `${TEST_WORKTREE_PATH}/README.md`
const CHAT_TAB_ID = 'agent-session:claude_29968'
const SERVE_PTY_ID = 'serve-29968-pty'

function sessionWithTerminalAndEditor(): WorkspaceSessionState {
  return makeWorkspaceSessionWithHeadlessTerminal({
    activeTabId: 'serve-tab',
    activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'serve-tab' },
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'serve-tab',
          ptyId: SERVE_PTY_ID,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'serve-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: SERVE_PTY_ID })
    },
    openFilesByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          filePath: README,
          relativePath: 'README.md',
          worktreeId: TEST_WORKTREE_ID,
          language: 'markdown',
          runtimeEnvironmentId: null
        }
      ]
    },
    unifiedTabs: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'tab-readme',
          entityId: README,
          groupId: 'group-1',
          worktreeId: TEST_WORKTREE_ID,
          contentType: 'editor',
          label: 'README.md',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 2
        }
      ]
    }
  })
}

function headlessRuntimeWithChat() {
  const harness = makeRuntimeStoreWithWorkspaceSession(sessionWithTerminalAndEditor())
  const runtime = new OrcaRuntimeService(harness.runtimeStore)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => [{ id: SERVE_PTY_ID, cwd: TEST_WORKTREE_PATH, title: 'sh' }])
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return runtime
}

async function openChat(runtime: OrcaRuntimeService): Promise<void> {
  await runtime.listMobileSessionTabs(WORKTREE)
  // As every product path opens one: main's layout records the tab first.
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: TEST_WORKTREE_ID,
    sessionId: 'claude_29968',
    agent: 'claude',
    activate: true
  })
}

describe('a chat tab on a host with no window', () => {
  it('survives the rebuild that closing a saved editor tab forces', async () => {
    const runtime = headlessRuntimeWithChat()
    await openChat(runtime)
    expect((await runtime.listMobileSessionTabs(WORKTREE)).tabs.map((tab) => tab.id)).toContain(
      CHAT_TAB_ID
    )

    await runtime.closeMobileSessionTab(WORKTREE, 'tab-readme', { reason: 'user' })

    const listed = await runtime.listMobileSessionTabs(WORKTREE)
    expect(listed.tabs.map((tab) => tab.id)).toContain(CHAT_TAB_ID)
    expect(listed.tabs.map((tab) => tab.id)).not.toContain('tab-readme')
    expect(listed.tabGroups?.flatMap((group) => group.tabOrder)).toContain(CHAT_TAB_ID)
    // The chat stays the tab the host shows, not the terminal the rebuild re-marked active.
    expect(listed.activeTabId).toBe(CHAT_TAB_ID)
    expect(listed.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual([CHAT_TAB_ID])
  })

  it('keeps its place in the tab order when the host lists the workspace again', async () => {
    const runtime = headlessRuntimeWithChat()
    await openChat(runtime)

    const listed = await runtime.listMobileSessionTabs(WORKTREE)

    expect(listed.tabGroups?.flatMap((group) => group.tabOrder)).toEqual([
      'serve-tab',
      'tab-readme',
      CHAT_TAB_ID
    ])
  })

  // L283: in a main-owned workspace the phone's chat reorder does not survive a row rebuild.
  ;(ORCA_LAYOUT_OWNER_IS_MAIN ? it.fails : it)(
    'lists tabs to phones in the order desktop clients draw after a rebuild',
    async () => {
      const runtime = headlessRuntimeWithChat()
      await openChat(runtime)
      const groupId = (await runtime.listMobileSessionTabs(WORKTREE)).tabGroups?.[0]?.id ?? ''
      await runtime.moveMobileSessionTab(WORKTREE, {
        kind: 'reorder',
        tabId: CHAT_TAB_ID,
        targetGroupId: groupId,
        tabOrder: [CHAT_TAB_ID, 'serve-tab', 'tab-readme']
      })

      await runtime.closeMobileSessionTab(WORKTREE, 'tab-readme', { reason: 'user' })

      const listed = await runtime.listMobileSessionTabs(WORKTREE)
      expect(listed.tabGroups?.flatMap((group) => group.tabOrder)).toEqual([
        CHAT_TAB_ID,
        'serve-tab'
      ])
      expect(
        listed.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))
      ).toEqual([CHAT_TAB_ID, 'serve-tab'])
    }
  )

  it('keeps the place a window gave a chat across a graph resend before the chat is restored', async () => {
    const runtime = headlessRuntimeWithChat()
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer:test',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'win-term::leaf-1',
          activeTabType: 'terminal',
          tabGroups: [
            { id: 'group-1', activeTabId: 'win-term', tabOrder: [CHAT_TAB_ID, 'win-term'] }
          ],
          tabs: [
            {
              type: 'terminal',
              id: 'win-term::leaf-1',
              parentTabId: 'win-term',
              leafId: 'leaf-1',
              title: 'Terminal',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      unchangedMobileSessionWorktrees: [TEST_WORKTREE_ID]
    })
    // As every product path opens one: main's layout records the tab first.
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: TEST_WORKTREE_ID,
      sessionId: 'claude_29968',
      agent: 'claude',
      activate: false
    })

    const listed = await runtime.listMobileSessionTabs(WORKTREE)
    // Switch point: main's layout owns the workspace's tabs and their order; a window draws them and
    // cannot add a tab or an order main lacks, so the chat takes its place in main's order.
    const expectedOrder = ORCA_LAYOUT_OWNER_IS_MAIN
      ? ['serve-tab', 'tab-readme', CHAT_TAB_ID]
      : [CHAT_TAB_ID, 'win-term', 'serve-tab']
    expect(listed.tabGroups?.flatMap((group) => group.tabOrder)).toEqual(expectedOrder)
    expect(listed.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))).toEqual(
      expectedOrder
    )
  })
})
