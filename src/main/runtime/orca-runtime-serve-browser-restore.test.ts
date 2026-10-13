import './orca-runtime-test-lifecycle.spec'
import type { RuntimeStore } from './runtime-store-contract'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { withOpenedServeBrowserTab } from './serve-browser-tab-layout'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { BLANK_BROWSER_TAB_STATE } from '../../shared/workspace-layout/workspace-layout-beside'

const BROWSER_ONLY_WORKTREE_ID = 'repo-1::/tmp/browser-only'

/** A host with no window whose saved session holds browser tabs from a run before a restart. */
function restartedServe(session: WorkspaceSessionState = savedServeTabs()) {
  const saved = session
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(saved)
  Object.assign(runtimeStore, { getWorkspaceSessionHostIds: () => ['local'] })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture supplies RuntimeStore methods; its legacy Mock return type loses callable signatures.
  const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
  const livePages: string[] = []
  const createTab = vi.fn(async ({ browserPageId }: { browserPageId?: string }) => {
    livePages.push(browserPageId!)
    return { browserPageId: browserPageId! }
  })
  const registered = () => new Map(livePages.map((pageId, index) => [pageId, index + 1]))
  runtime.setOffscreenBrowserBackend({ createTab, closeTab: vi.fn(async () => {}) })
  runtime.setAgentBrowserBridge(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only tabList from the bridge on these paths.
    {
      tabList: vi.fn(() => ({
        tabs: livePages.map((browserPageId, index) => ({
          browserPageId,
          index,
          url: 'https://example.com/',
          title: 'Example',
          active: false
        }))
      })),
      getRegisteredTabs: vi.fn(() => registered()),
      snapshot: vi.fn(async () => ({ snapshot: '' })),
      getActivePageId: vi.fn(() => livePages[0] ?? null),
      tabSwitch: vi.fn(async (_index: unknown, _worktreeId: unknown, browserPageId: string) => ({
        switched: livePages.indexOf(browserPageId),
        browserPageId
      }))
    } as never
  )
  return { runtime, createTab, getSession }
}

function savedServeTabs(): WorkspaceSessionState {
  let session = makeWorkspaceSessionWithHeadlessTerminal()
  for (const [worktreeId, pageId] of [
    [TEST_WORKTREE_ID, 'page-1'],
    [TEST_WORKTREE_ID, 'page-2'],
    [BROWSER_ONLY_WORKTREE_ID, 'page-3']
  ] as const) {
    session = withOpenedServeBrowserTab('local', session, {
      worktreeId,
      pageId,
      url: 'https://example.com/',
      title: 'Example'
    })!
  }
  return session
}

/** A tab a window saved: its tab, page and unified tab each have their own id. */
function desktopSavedTab(): WorkspaceSessionState {
  const session = makeWorkspaceSessionWithHeadlessTerminal()
  const state = { ...BLANK_BROWSER_TAB_STATE, url: 'https://example.com/', title: 'Example' }
  return {
    ...session,
    browserTabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          ...state,
          id: 'tab-desk',
          worktreeId: TEST_WORKTREE_ID,
          activePageId: 'page-desk',
          pageIds: ['page-desk'],
          createdAt: 1
        }
      ]
    },
    browserPagesByWorkspace: {
      'tab-desk': [
        {
          ...state,
          id: 'page-desk',
          workspaceId: 'tab-desk',
          worktreeId: TEST_WORKTREE_ID,
          createdAt: 1
        }
      ]
    },
    unifiedTabs: {
      [TEST_WORKTREE_ID]: [
        ...(session.unifiedTabs?.[TEST_WORKTREE_ID] ?? []),
        {
          id: 'unified-desk',
          entityId: 'tab-desk',
          groupId: 'group-1',
          worktreeId: TEST_WORKTREE_ID,
          contentType: 'browser',
          label: 'Example',
          customLabel: null,
          color: '#3b82f6',
          isPinned: true,
          sortOrder: 9,
          createdAt: 1
        }
      ]
    }
  }
}

describe('a saved browser tab on a host with no window', () => {
  it('is listed after a restart without starting its page', async () => {
    const { runtime, createTab } = restartedServe()

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs.find((tab) => tab.type === 'browser')).toMatchObject({
      id: 'page-1',
      browserPageId: 'page-1',
      url: 'https://example.com/',
      title: 'Example'
    })
    expect(createTab).not.toHaveBeenCalled()
  })

  it('starts its page once, at its saved address, when a client opens it', async () => {
    const { runtime, createTab } = restartedServe()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await Promise.all([
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-1'),
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-1')
    ])

    expect(createTab).toHaveBeenCalledTimes(1)
    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: 'page-1',
        url: 'https://example.com/',
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('is forgotten when a client closes it', async () => {
    const { runtime, getSession } = restartedServe()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-1')

    const saved = getSession().browserTabsByWorktree?.[TEST_WORKTREE_ID] ?? []
    expect(saved.map((tab) => tab.id)).toEqual(['page-2'])
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs.some((tab) => tab.id === 'page-1')).toBe(false)
  })

  it('starts its page for a command that names only the page', async () => {
    const { runtime, createTab } = restartedServe()

    expect(await runtime['serveBrowserTabs'].restore(undefined, 'page-1')).toBe(true)

    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-1', worktreeId: TEST_WORKTREE_ID })
    )
  })

  it('is listed by a tab list without starting, and the active one starts for a pageless command', async () => {
    const { runtime, createTab } = restartedServe()

    const listed = await runtime.browserTabList({ worktree: `id:${TEST_WORKTREE_ID}` })
    expect(listed.tabs.map((tab) => tab.browserPageId)).toEqual(['page-1', 'page-2'])
    const current = await runtime.browserTabCurrent({ worktree: `id:${TEST_WORKTREE_ID}` })
    expect(current.tab.browserPageId).toBe('page-2')
    expect(createTab).not.toHaveBeenCalled()

    // The last tab opened is the one the layout shows, as a window shows it.
    await runtime.browserSnapshot({ worktree: `id:${TEST_WORKTREE_ID}` })
    expect(createTab).toHaveBeenCalledTimes(1)
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ browserPageId: 'page-2' }))
  })

  it('starts no page for a pageless command when the layout shows no browser tab', async () => {
    const saved = savedServeTabs()
    const { runtime, createTab } = restartedServe({ ...saved, activeBrowserTabIdByWorktree: {} })

    await expect(runtime.browserTabCurrent({ worktree: `id:${TEST_WORKTREE_ID}` })).rejects.toThrow(
      'No browser tab open in this worktree'
    )
    await runtime.browserSnapshot({ worktree: `id:${TEST_WORKTREE_ID}` }).catch(() => undefined)
    expect(createTab).not.toHaveBeenCalled()
  })

  it('saves a switched-to tab as the one its worktree shows', async () => {
    const { runtime, getSession } = restartedServe()

    await runtime.browserTabSwitch({ worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1' })

    expect(getSession().activeBrowserTabIdByWorktree?.[TEST_WORKTREE_ID]).toBe('page-1')
  })

  it('starts the named page for a tab switch', async () => {
    const { runtime, createTab } = restartedServe()

    const switched = await runtime.browserTabSwitch({
      worktree: `id:${TEST_WORKTREE_ID}`,
      page: 'page-2'
    })

    expect(switched.browserPageId).toBe('page-2')
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ browserPageId: 'page-2' }))
  })

  it('is found by page alone in a workspace that holds only browser tabs', async () => {
    const { runtime, createTab } = restartedServe()

    expect(await runtime['serveBrowserTabs'].restore(undefined, 'page-3')).toBe(true)

    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-3', worktreeId: BROWSER_ONLY_WORKTREE_ID })
    )
  })

  it('is closed by page alone before its page starts', async () => {
    const { runtime, getSession, createTab } = restartedServe()

    expect(await runtime.browserTabClose({ page: 'page-3' })).toEqual({ closed: true })

    expect(getSession().browserTabsByWorktree?.[BROWSER_ONLY_WORKTREE_ID] ?? []).toEqual([])
    expect(createTab).not.toHaveBeenCalled()
  })

  it("keeps a window-saved tab's pin and colour once its page starts", async () => {
    const { runtime } = restartedServe(desktopSavedTab())
    const browserRow = async () =>
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs.find(
        (tab) => tab.type === 'browser'
      )
    expect(await browserRow()).toMatchObject({ color: '#3b82f6', isPinned: true })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-desk')

    expect(await browserRow()).toMatchObject({
      browserPageId: 'page-desk',
      color: '#3b82f6',
      isPinned: true
    })
  })
})
