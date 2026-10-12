import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  electronMocks,
  getRuntimeBrowserPageRegistry,
  listWorktrees,
  type WorkspaceSessionState
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  UUID_RE,
  deferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  store
} from '../orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../../shared/constants'

// The phone list projects the Store's workspace session, so a window's terminals are seeded there.
function sessionWithTerminals(tabs: Record<string, Record<string, string | undefined>>) {
  const ids = Object.keys(tabs)
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: ids.map((id, sortOrder) => ({
        id,
        ptyId: null,
        worktreeId: TEST_WORKTREE_ID,
        title: id,
        customTitle: null,
        color: null,
        sortOrder,
        createdAt: sortOrder + 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      ids.map((id) => [id, makeHeadlessTerminalLayout(tabs[id]!)])
    ),
    tabGroups: {
      [TEST_WORKTREE_ID]: [
        { id: 'group-1', worktreeId: TEST_WORKTREE_ID, activeTabId: ids[0]!, tabOrder: ids }
      ]
    },
    activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-1' }
  } satisfies WorkspaceSessionState
}

// The phone list projects the Store's workspace session, so a window's browser tab is seeded there.
function sessionWithBrowserTab(tabId: string, workspaceId: string, pageId: string) {
  return {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: {
      [TEST_WORKTREE_ID]: [
        {
          id: tabId,
          entityId: workspaceId,
          groupId: 'group-1',
          worktreeId: TEST_WORKTREE_ID,
          contentType: 'browser' as const,
          label: 'Browser',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    browserTabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          id: workspaceId,
          worktreeId: TEST_WORKTREE_ID,
          activePageId: pageId,
          pageIds: [pageId],
          url: 'https://example.com/',
          title: 'Browser',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      [TEST_WORKTREE_ID]: [
        { id: 'group-1', worktreeId: TEST_WORKTREE_ID, activeTabId: tabId, tabOrder: [tabId] }
      ]
    }
  } satisfies WorkspaceSessionState
}

describe('OrcaRuntimeService', () => {
  it.each([false, true])(
    'retires client-hosted session tabs through their selected engine when offscreen=%s',
    async (withOffscreen) => {
      const runtime = new OrcaRuntimeService(store)
      const pages = getRuntimeBrowserPageRegistry(runtime)
      const placement = {
        kind: 'client' as const,
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        pageHostGeneration: 9
      }
      pages.publishClientPage({
        browserPageId: 'client-page-1',
        workspaceId: TEST_WORKTREE_ID,
        browserProfileId: 'default',
        executionHostKey: 'native:runtime-a:1',
        placement,
        url: 'https://remote.internal/',
        loading: false,
        active: true
      })
      // A client-placed create with no window: the scan has cataloged the worktree, and the
      // holder adds the page's tab.
      await runtime['listResolvedWorktrees']()
      runtime.addHeadlessBrowserLayoutTab(TEST_WORKTREE_ID, 'client-page-1')
      const closeOffscreenTab = vi.fn()
      if (withOffscreen) {
        runtime.setOffscreenBrowserBackend({
          createTab: vi.fn(),
          closeTab: closeOffscreenTab
        })
      }
      runtime.syncWindowGraph(0, {
        tabs: [],
        leaves: []
      })
      const closeClientPage = vi
        .spyOn(runtime, 'browserTabClose')
        .mockImplementation(async ({ page }) => {
          expect(pages.retirePage(page!, placement)).toBe(true)
          return { closed: true }
        })

      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
        expect.objectContaining({ browserPageId: 'client-page-1', placement })
      ])
      await expect(
        runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'client-page-1')
      ).resolves.toEqual({ closed: true })

      expect(closeClientPage).toHaveBeenCalledWith({
        worktree: `id:${TEST_WORKTREE_ID}`,
        page: 'client-page-1'
      })
      expect(closeOffscreenTab).not.toHaveBeenCalled()
      expect(pages.getPage('client-page-1')).toBeUndefined()
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
    }
  )

  it('closes an offscreen browser without overwriting a concurrent session update', async () => {
    const closeProof = deferred<void>()
    const closeOffscreenTab = vi.fn(() => closeProof.promise)
    const closeSessionTab = vi.fn()
    const seeded = sessionWithBrowserTab('offscreen-page-1', 'offscreen-page-1', 'offscreen-page-1')
    store.setWorkspaceSession(seeded)
    const runtime = new OrcaRuntimeService(store)
    runtime.setOffscreenBrowserBackend({
      createTab: vi.fn(),
      closeTab: closeOffscreenTab
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const closing = runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'offscreen-page-1')
    await vi.waitFor(() => expect(closeOffscreenTab).toHaveBeenCalledWith('offscreen-page-1'))

    // Another writer opens a file while the close waits on the offscreen backend.
    const notes = {
      filePath: '/worktree/notes.md',
      relativePath: 'notes.md',
      worktreeId: TEST_WORKTREE_ID,
      language: 'markdown'
    }
    store.setWorkspaceSession({
      ...seeded,
      openFilesByWorktree: { [TEST_WORKTREE_ID]: [notes] },
      unifiedTabs: {
        [TEST_WORKTREE_ID]: [
          ...seeded.unifiedTabs[TEST_WORKTREE_ID],
          {
            id: notes.filePath,
            entityId: notes.filePath,
            groupId: 'group-1',
            worktreeId: TEST_WORKTREE_ID,
            contentType: 'editor',
            label: 'notes.md',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-1',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'offscreen-page-1',
            tabOrder: ['offscreen-page-1', notes.filePath]
          }
        ]
      }
    })
    closeProof.resolve()
    await expect(closing).resolves.toEqual({ closed: true })

    expect(closeSessionTab).not.toHaveBeenCalled()
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ id: notes.filePath, type: 'markdown' })
    ])
  })

  it('creates mobile session terminals in a headless runtime server', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-headless' })
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      getDefaultWorkspaceSession()
    )
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      viewMode: 'chat'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        tabId: expect.stringMatching(UUID_RE),
        leafId: expect.stringMatching(UUID_RE),
        runtimeAdmittedPane: true,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    expect(result.tab).toMatchObject({
      type: 'terminal',
      status: 'ready',
      terminal: expect.stringMatching(/^term_/),
      viewMode: 'chat',
      isActive: true
    })
    // Written with the pane before spawn, so a serve restart keeps the initial mode.
    expect(
      getSession().tabsByWorktree[TEST_WORKTREE_ID]?.find(
        (tab) => tab.id === result.tab.parentTabId
      )?.viewMode
    ).toBe('chat')

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        id: result.tab.id,
        status: 'ready',
        terminal: result.tab.terminal
      })
    ])
  })

  it.each([
    {
      label: 'after the split parent for a capable client',
      supportsSplitGroupPlacement: true,
      expectedOrder: (createdId: string) => [
        'split::left',
        'split::right',
        createdId,
        'trailing::leaf'
      ]
    },
    {
      label: 'at the end for an older client',
      supportsSplitGroupPlacement: false,
      expectedOrder: (createdId: string) => [
        'split::left',
        'split::right',
        'trailing::leaf',
        createdId
      ]
    }
  ])('places a runtime-owned terminal $label', async (testCase) => {
    store.setWorkspaceSession(
      sessionWithTerminals({
        split: { left: undefined, right: undefined },
        trailing: { leaf: undefined }
      })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-created-after-split' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: []
    })

    const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      afterTabId: 'split::left',
      clientNavigationId: 'mobile-client',
      supportsSplitGroupPlacement: testCase.supportsSplitGroupPlacement
    })

    expect(
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs.map((tab) => tab.id)
    ).toEqual(testCase.expectedOrder(created.tab.id))
  })

  it.each([
    ['paired', 'reloading'],
    ['paired', 'unavailable'],
    ['unpaired', 'reloading'],
    ['unpaired', 'unavailable']
  ] as const)(
    'does not spawn a %s terminal while the headed renderer graph is %s',
    async (caller, graphStatus) => {
      const spawn = vi.fn()
      const send = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send,
          setBackgroundThrottling: vi.fn(),
          capturePage: vi.fn(async () => null)
        }
      })
      if (graphStatus === 'reloading') {
        runtime.markRendererReloading(1)
      } else {
        runtime.markGraphUnavailable(1)
      }

      await expect(
        runtime.createMobileSessionTerminal(
          `id:${TEST_WORKTREE_ID}`,
          caller === 'paired'
            ? { clientNavigationId: 'device-a', navigation: 'caller' as const }
            : {}
        )
      ).rejects.toThrow('runtime_unavailable')
      expect(spawn).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    }
  )

  it('rejects a paired create if renderer authority changes across async resolution', async () => {
    const spawn = vi.fn()
    const send = vi.fn()
    const setBackgroundThrottling = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send,
        setBackgroundThrottling,
        capturePage: vi.fn(async () => null)
      }
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    let resolutionStarted = (): void => {}
    const started = new Promise<void>((resolve) => {
      resolutionStarted = resolve
    })
    let releaseResolution = (): void => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseResolution = () => resolve(MOCK_GIT_WORKTREES)
          resolutionStarted()
        })
    )

    const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      clientNavigationId: 'device-a',
      navigation: 'caller'
    })
    await started
    expect(spawn).not.toHaveBeenCalled()
    runtime.markRendererReloading(1)
    releaseResolution()
    await expect(create).rejects.toThrow('runtime_unavailable')
    expect(send).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('cancels a paired renderer-owned create before publication when its client disconnects', async () => {
    const spawn = vi.fn()
    const send = vi.fn()
    const setBackgroundThrottling = vi.fn()
    const abort = new AbortController()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send,
        setBackgroundThrottling,
        capturePage: vi.fn(async () => null)
      }
    })
    abort.abort()

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        clientNavigationId: 'device-a',
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')
    expect(spawn).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('selects a created terminal only for the paired caller', async () => {
    let spawnIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `pty-headless-${++spawnIndex}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const hostTerminal = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`)

    const callerTerminal = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      clientNavigationId: 'device-a',
      navigation: 'caller'
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).activeTabId).toBe(
      hostTerminal.tab.id
    )
    expect(
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-a')).activeTabId
    ).toBe(callerTerminal.tab.id)
    expect(
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-b')).activeTabId
    ).toBe(hostTerminal.tab.id)
  })

  it('scopes terminal-create idempotency to the paired caller', async () => {
    let spawnIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `pty-headless-${++spawnIndex}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const [createdA, createdB] = await Promise.all([
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        clientNavigationId: 'device-a',
        navigation: 'caller',
        clientMutationId: 'same-mutation'
      }),
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        clientNavigationId: 'device-b',
        navigation: 'caller',
        clientMutationId: 'same-mutation'
      })
    ])

    expect(createdA.tab.id).not.toBe(createdB.tab.id)
    expect(spawnIndex).toBe(2)
  })
})
