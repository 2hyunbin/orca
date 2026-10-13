import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { nextWindowlessSnapshot } from './windowless-session-tabs'
import {
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

const WT = `id:${TEST_WORKTREE_ID}`

/** A host with no window whose saved layout shows its second group, holding a browser tab. */
function twoGroupHost(overrides: Partial<WorkspaceSessionState> = {}) {
  const page = {
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 2
  }
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-right' },
      unifiedTabs: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'page-1',
            entityId: 'page-1',
            groupId: 'group-right',
            worktreeId: TEST_WORKTREE_ID,
            contentType: 'browser',
            label: 'Example',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      browserTabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          { ...page, id: 'page-1', worktreeId: TEST_WORKTREE_ID, pageIds: ['page-1'] }
        ]
      },
      browserPagesByWorkspace: {
        'page-1': [{ ...page, id: 'page-1', workspaceId: 'page-1', worktreeId: TEST_WORKTREE_ID }]
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-left',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'host-tab',
            tabOrder: ['host-tab']
          },
          {
            id: 'group-right',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'page-1',
            tabOrder: ['page-1']
          }
        ]
      },
      ...overrides
    })
  )
  const runtime = new OrcaRuntimeService(runtimeStore as never)
  // Electron serve: the saved browser tab can start on this host.
  runtime.setOffscreenBrowserBackend({
    createTab: async ({ browserPageId }: { browserPageId?: string }) => ({
      browserPageId: browserPageId!
    }),
    closeTab: async () => {}
  } as never)
  return { runtime, getSession, setSession }
}

describe('the session-tabs list of a host with no window', () => {
  it('lists the saved groups, order and selection', async () => {
    const { runtime } = twoGroupHost()

    const listed = await runtime.listMobileSessionTabs(WT)

    expect(listed.activeGroupId).toBe('group-right')
    expect(listed.tabGroups?.map(({ id, tabOrder }) => [id, tabOrder])).toEqual([
      ['group-left', ['host-tab']],
      ['group-right', ['page-1']]
    ])
    expect(listed.activeTabId).toBe('page-1')
  })

  it('saves a tap as the shown tab, so the list keeps it', async () => {
    const { runtime, getSession } = twoGroupHost({
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-left' }
    })
    expect((await runtime.listMobileSessionTabs(WT)).activeGroupId).toBe('group-left')

    await runtime.activateMobileSessionTab(WT, 'page-1')

    expect(getSession().activeGroupIdByWorktree?.[TEST_WORKTREE_ID]).toBe('group-right')
    const listed = await runtime.listMobileSessionTabs(WT)
    expect([listed.activeGroupId, listed.activeTabId]).toEqual(['group-right', 'page-1'])
  })

  it('saves an opened chat in the shown group, as its last tab', async () => {
    const { runtime, getSession } = twoGroupHost()
    await runtime.listMobileSessionTabs(WT)

    await runtime.publishStructuredAgentSessionTab({
      workspaceId: TEST_WORKTREE_ID,
      sessionId: 'session-a',
      agent: 'codex',
      activate: true
    })

    const listed = await runtime.listMobileSessionTabs(WT)
    expect(listed.tabGroups?.[1]).toMatchObject({
      id: 'group-right',
      activeTabId: 'agent-session:session-a',
      tabOrder: ['page-1', 'agent-session:session-a']
    })
    expect(listed.activeTabId).toBe('agent-session:session-a')
    expect(getSession().tabGroups?.[TEST_WORKTREE_ID]?.[1]?.tabOrder).toHaveLength(2)
  })

  it('names the agent of a chat tab saved before tabs named it', async () => {
    const { runtime, getSession } = twoGroupHost()
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: TEST_WORKTREE_ID,
      sessionId: 'session-a',
      agent: 'codex',
      activate: false
    })
    const saved = getSession().unifiedTabs![TEST_WORKTREE_ID]!
    const { runtime: restarted } = twoGroupHost({
      unifiedTabs: {
        [TEST_WORKTREE_ID]: saved.map(({ agentSessionAgent: _agent, ...tab }) => tab)
      },
      tabGroups: getSession().tabGroups
    })

    await restarted.publishStructuredAgentSessionTab({
      workspaceId: TEST_WORKTREE_ID,
      sessionId: 'session-a',
      agent: 'codex',
      activate: false
    })

    const listed = await restarted.listMobileSessionTabs(WT)
    expect(listed.tabs.some((tab) => tab.id === 'agent-session:session-a')).toBe(true)
  })

  it('keeps the tab terminal of a one-pane tab whose pane lost its binding', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        terminalLayoutsByTabId: { 'host-tab': makeHeadlessTerminalLayout({}) }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const listed = await runtime.listMobileSessionTabs(WT)

    expect(listed.tabs).toEqual([
      expect.objectContaining({ parentTabId: 'host-tab', ptyId: 'persisted-pty' })
    ])
  })

  it('republishes a saved change in the same publication, one version on', async () => {
    const { runtime } = twoGroupHost()
    const listed = await runtime.listMobileSessionTabs(WT)
    const existing = {
      ...listed,
      publicationEpoch: 'headless-hydrated:earlier',
      snapshotVersion: 4
    }

    const next = nextWindowlessSnapshot(
      TEST_WORKTREE_ID,
      { ...listed, activeTabId: null },
      existing
    )

    expect(next).toMatchObject({
      publicationEpoch: 'headless-hydrated:earlier',
      snapshotVersion: 5
    })
  })

  it("replaces a closed window's publication with the host's own", async () => {
    const { runtime } = twoGroupHost()
    const listed = await runtime.listMobileSessionTabs(WT)
    const existing = { ...listed, publicationEpoch: 'renderer-epoch', snapshotVersion: 4 }

    const next = nextWindowlessSnapshot(TEST_WORKTREE_ID, listed, existing)

    expect(next?.publicationEpoch).toMatch(/^headless-hydrated:/)
    expect(next?.snapshotVersion).toBe(5)
  })

  it('tells subscribers about a saved change that a list read first', async () => {
    const { runtime, getSession, setSession } = twoGroupHost({
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-left' }
    })
    await runtime.listMobileSessionTabs(WT)
    const published = vi.fn()
    runtime.onMobileSessionTabsChanged(published)

    setSession({
      ...getSession(),
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-right' }
    })
    // A list before the write's own republish stores the change first.
    await runtime.listMobileSessionTabs(WT)
    await Promise.resolve()

    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({ activeGroupId: 'group-right' }),
      expect.any(Number)
    )
  })
})
