import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  electronMocks,
  getDefaultWorkspaceSession
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'

// The phone list projects the Store's workspace session, so a window's tabs are seeded there.
function seedTerminalTab(
  ptyIdsByLeafId: Record<string, string | undefined>,
  activeLeafId?: string
) {
  const layout = makeHeadlessTerminalLayout(ptyIdsByLeafId)
  store.setWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'tab-1' },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'tab-1',
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': { ...layout, activeLeafId: activeLeafId ?? layout.activeLeafId }
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          { id: 'group-1', worktreeId: TEST_WORKTREE_ID, activeTabId: 'tab-1', tabOrder: ['tab-1'] }
        ]
      },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-1' }
    })
  )
}

describe('OrcaRuntimeService', () => {
  it('retires exited saved PTY bindings instead of publishing a pending ghost', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              ptyId: 'daemon-pty-1',
              isActive: true
            }
          ]
        }
      ]
    })
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    runtime.onPtyExit('daemon-pty-1', 0)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result).toMatchObject({
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
  })

  it('resolves mobile terminal surfaces by exact split leaf', async () => {
    seedTerminalTab({ 'pane:1': 'pty-1', 'pane:2': 'pty-2' }, 'pane:2')
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:2',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'left'
        },
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:2',
          paneRuntimeId: 2,
          ptyId: 'pty-2',
          paneTitle: 'right'
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toHaveLength(2)
    expect(result.tabs).toEqual([
      expect.objectContaining({ id: 'tab-1::pane:1', title: 'left', status: 'ready' }),
      expect.objectContaining({ id: 'tab-1::pane:2', title: 'right', status: 'ready' })
    ])
    const [left, right] = result.tabs
    expect(left?.type).toBe('terminal')
    expect(right?.type).toBe('terminal')
    if (left?.type === 'terminal' && right?.type === 'terminal') {
      expect(left.terminal).not.toBe(right.terminal)
    }
  })

  it('keeps published mobile terminal handles usable across renderer graph epochs', async () => {
    seedTerminalTab({ 'pane:1': 'pty-1' })
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const tab = result.tabs[0]
    expect(tab?.type).toBe('terminal')
    if (tab?.type !== 'terminal' || tab.status !== 'ready') {
      throw new Error('expected ready terminal tab')
    }

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'after graph sync\n', 100)

    await expect(runtime.readTerminal(tab.terminal)).resolves.toMatchObject({
      handle: tab.terminal,
      tail: ['after graph sync']
    })
  })

  it('closes the matching mobile terminal UUID leaf without closing the whole tab', async () => {
    const leftLeafId = '11111111-1111-4111-8111-111111111111'
    const rightLeafId = '22222222-2222-4222-8222-222222222222'
    seedTerminalTab({ [leftLeafId]: 'pty-left', [rightLeafId]: 'pty-right' }, rightLeafId)
    const closeTerminal = vi.fn()
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    // A live window owns the layout, so it is told to drop the pane.
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: rightLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: leftLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-left',
          paneTitle: 'left'
        },
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: rightLeafId,
          paneRuntimeId: 2,
          ptyId: 'pty-right',
          paneTitle: 'right'
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, `tab-1::${rightLeafId}`)

    expect(kill).toHaveBeenCalledWith('pty-right')
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('closes the whole mobile terminal tab when addressed by parent tab id', async () => {
    seedTerminalTab({ 'pane:1': 'pty-1' })
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-1')

    // The runtime's layout closes the whole tab, with or without a window.
    expect(runtime.heldWorkspaceLayout(TEST_WORKTREE_ID)?.tabs ?? []).toHaveLength(0)
  })

  it('activates the active split leaf when addressed by parent tab id', async () => {
    const leafA = '11111111-1111-4111-8111-111111111111'
    const leafB = '22222222-2222-4222-8222-222222222222'
    seedTerminalTab({ [leafA]: 'pty-pane-1', [leafB]: 'pty-pane-2' }, leafB)
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.registerPty('pty-pane-1', TEST_WORKTREE_ID)
    runtime.registerPty('pty-pane-2', TEST_WORKTREE_ID)

    const navigations: unknown[] = []
    runtime.layoutCommands.views.onNavigate('desktop', (request) => navigations.push(request))

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-1')

    // The desktop view shows the split's active pane, and its window is told to go there.
    expect(runtime.layoutCommands.views.record('desktop').panes['tab-1']?.activeLeafId).toBe(leafB)
    expect(navigations).toEqual([
      { kind: 'focusPane', workspace: TEST_WORKTREE_ID, paneKey: `tab-1:${leafB}` }
    ])
  })

  it('activates mobile session tabs without focusing desktop clients when requested', async () => {
    seedTerminalTab({ 'pane:1': 'pty-pane-1', 'pane:2': 'pty-pane-2' }, 'pane:2')
    const focusTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.registerPty('pty-pane-1', TEST_WORKTREE_ID)
    runtime.registerPty('pty-pane-2', TEST_WORKTREE_ID)

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'tab-1::pane:1',
      undefined,
      { notifyClients: false }
    )

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(activated).toMatchObject({
      activeTabId: 'tab-1::pane:1',
      activeTabType: 'terminal',
      tabGroups: [expect.objectContaining({ id: 'group-1', activeTabId: 'tab-1' })]
    })
    expect(activated.tabs).toEqual([
      expect.objectContaining({ id: 'tab-1::pane:1', isActive: true }),
      expect.objectContaining({ id: 'tab-1::pane:2', isActive: false })
    ])
  })

  it('clears unread metadata on mobile worktree activation without focusing desktop clients', async () => {
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: true })
    }
    const setWorktreeMeta = vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
      return metaById[worktreeId]
    })
    const activateWorktree = vi.fn()
    const worktreesChanged = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    } as never)
    runtime.setNotifier({
      worktreesChanged,
      reposChanged: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, { notifyClients: false })

    expect(setWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, { isUnread: false })
    expect(metaById[TEST_WORKTREE_ID]?.isUnread).toBe(false)
    expect(worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    expect(activateWorktree).not.toHaveBeenCalled()
  })

  it('wakes slept agents on the host renderer when a phone activates a worktree', async () => {
    // Seed isUnread:false so the unread-clear branch stays quiet, isolating the mobile slept-agent wake.
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: false })
    }
    const activateWorktree = vi.fn()
    const resumeSleepingAgents = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession: () => ({
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: {
          'tab-1:leaf-1': {
            paneKey: 'tab-1:leaf-1',
            tabId: 'tab-1',
            worktreeId: TEST_WORKTREE_ID,
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'session-1' },
            prompt: 'test',
            state: 'done',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'worktree-sleep'
          }
        }
      })
    } as never)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      sleepWorktree: vi.fn(),
      resumeSleepingAgents,
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    // A renderer must be attached to receive the wake; headless serve reports 'unsupported-headless' instead.
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    const result = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'mobile'
    })

    // INV-2: mobile wake never navigates the desktop (no activateWorktree); it routes through the renderer's navigation-free wake.
    expect(resumeSleepingAgents).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(activateWorktree).not.toHaveBeenCalled()
    expect(result.sleepingAgentWake).toBe('requested')
  })
})
