import { withDurableRuntimeStore } from '../runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { RuntimeMobileSessionTabsResult } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('uses fresh PTY management titles over stale renderer and OSC titles', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const leafId = HEADLESS_LEAF_ID
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'laptop-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: []
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;claude agents\x07', 124)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents'
      })
    )
  })

  it('uses fresh neutral PTY titles over stale renderer and OSC titles', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = HEADLESS_LEAF_ID
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'laptop-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: []
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;zsh\x07', 124)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'zsh'
      })
    )
  })

  it('pushes PTY-backed mobile session retirement when a server PTY exits', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    await runtime.onPtyExit('laptop-created-pty', 0)

    expect(events).toEqual([
      expect.objectContaining({
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      })
    ])
    await expect(runtime.readTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('operates PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })

    await expect(runtime.renameTerminal(laptopTerminal.handle, 'Shared Claude')).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      title: 'Shared Claude'
    })
    await expect(runtime.focusTerminal(laptopTerminal.handle)).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      worktreeId: TEST_WORKTREE_ID,
      // The runtime's layout moves the desktop view to it, with or without a window.
      navigated: true
    })
    await expect(runtime.closeTerminal(laptopTerminal.handle)).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      ptyKilled: true
    })
    expect(kill).toHaveBeenCalledWith('laptop-created-pty')
    expect(runtime.heldWorkspaceLayout(TEST_WORKTREE_ID)?.tabs ?? []).toHaveLength(0)
  })

  it('reuses pane close for live PTYs that do not own a renderer tab', async () => {
    const kill = vi.fn(() => true)
    const closeTerminalTab = vi.fn(async () => {})
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'floating-created-pty',
          cwd: TEST_WORKTREE_PATH,
          title: 'Claude'
        }
      ]
    })
    runtime.registerPty('floating-created-pty', TEST_WORKTREE_ID)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.closeTerminalTab(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      tabId: terminal.tabId,
      ptyKilled: true
    })
    expect(kill).toHaveBeenCalledWith('floating-created-pty')
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })

  it('durably closes every split leaf without a renderer', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'durable-tab',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Durable',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'durable-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
        }
      })
    )
    const flushOrThrow = vi.fn()
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'headless-left' })
      .mockResolvedValueOnce({ id: 'headless-right' })
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({ ...runtimeStore, flushOrThrow })
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'durable-tab',
      leafId: HEADLESS_LEAF_ID
    })
    await runtime.splitTerminal(terminal.handle, { direction: 'vertical' })

    await runtime.closeTerminalTab(terminal.handle)

    expect(kill).toHaveBeenCalledWith('headless-left')
    expect(kill).toHaveBeenCalledWith('headless-right')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['durable-tab']).toBeUndefined()
    // Two binds, the split and the close each reach disk.
    expect(flushOrThrow).toHaveBeenCalledTimes(4)
  })

  it('lists PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07hello\r\n', 123)

    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [
        expect.objectContaining({
          handle: laptopTerminal.handle,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          connected: true,
          preview: 'hello'
        })
      ],
      totalCount: 1,
      truncated: false
    })
  })

  it('shows and resolves active PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07hello\r\n', 123)

    await expect(runtime.resolveActiveTerminal(`id:${TEST_WORKTREE_ID}`)).resolves.toBe(
      laptopTerminal.handle
    )
    await expect(runtime.showTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID,
      worktreeId: TEST_WORKTREE_ID,
      title: 'Claude working',
      connected: true,
      ptyId: 'laptop-created-pty'
    })
  })
})
