import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import { makePendingAgentTabActivationRuntime } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('materializes a plain shell when the pending tab has no launch agent', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'serve-materialized-pty' })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'serve-dead-pty',
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
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-dead-pty' })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      { notifyClients: false }
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'serve-dead-pty', worktreeId: TEST_WORKTREE_ID })
    )
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
  })

  it('falls back to a plain shell when the pending tab agent is disabled', async () => {
    const { runtime, spawn } = makePendingAgentTabActivationRuntime({
      disabledTuiAgents: ['claude']
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      { notifyClients: false }
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'serve-dead-pty', worktreeId: TEST_WORKTREE_ID })
    )
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
    // Why: the disabled-agent fallback keeps the tab's agent identity; only the startup command is skipped.
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      status: 'ready',
      launchAgent: 'claude'
    })
  })

  it('hydrates legacy persisted terminal tabs without layout entries', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        terminalLayoutsByTabId: {}
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminal = listed.tabs[0]

    expect(terminal).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      ptyId: 'persisted-pty',
      status: 'pending-handle'
    })
    expect(terminal?.id).toMatch(/^host-tab::[0-9a-f-]{36}$/)
  })

  it('does not mark persisted PTY id collisions ready without matching pane identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    let rows: AgentStatusIpcPayload[] = []
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => rows,
      getAgentProviderSessionRowsForPane: () => []
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'Unrelated PTY' }
      ]
    })
    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'other-tab',
      leafId: '99999999-9999-4999-8999-999999999999'
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const unrelatedPty = runtime['ptysById'].get('persisted-pty')!
    const unrelatedHandle = runtime['issuePtyHandle'](unrelatedPty)
    rows = [
      {
        paneKey: 'other-tab:99999999-9999-4999-8999-999999999999',
        tabId: 'other-tab',
        worktreeId: TEST_WORKTREE_ID,
        terminalHandle: unrelatedHandle,
        connectionId: null,
        state: 'working',
        prompt: 'unrelated task',
        agentType: 'codex',
        receivedAt: Date.now(),
        stateStartedAt: Date.now()
      }
    ]

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'pending-handle',
      terminal: null
    })
    expect(listed.tabs[0]).not.toHaveProperty('agentStatus')
  })

  it('reads and indexes the full agent-status snapshot once per mobile projection', async () => {
    const tabCount = 20
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const tabs = Array.from({ length: tabCount }, (_, index) => ({
      ...session.tabsByWorktree[TEST_WORKTREE_ID]![0]!,
      id: `host-tab-${index}`,
      ptyId: `missing-pty-${index}`
    }))
    const terminalLayoutsByTabId = Object.fromEntries(
      tabs.map((tab, index) => [
        tab.id,
        makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: `missing-pty-${index}` })
      ])
    )
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      tabsByWorktree: { [TEST_WORKTREE_ID]: tabs },
      terminalLayoutsByTabId
    })
    const getAgentStatusSnapshot = vi.fn(() => [])
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot,
      getAgentProviderSessionRowsForPane: () => []
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toHaveLength(tabCount)
    expect(getAgentStatusSnapshot).toHaveBeenCalledOnce()
  })

  it('kills persisted SSH PTYs when closing hydrated headless tabs before pane metadata is restored', async () => {
    const persistedPtyId = 'ssh:ssh-1@@relay-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: persistedPtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: persistedPtyId })
        }
      })
    )
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: persistedPtyId, cwd: TEST_WORKTREE_PATH, title: 'Remote' }]
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(kill).toHaveBeenCalledWith(persistedPtyId)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('materializes hydrated pending headless terminals with the persisted session identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const spawn = vi.fn().mockResolvedValue({ id: 'persisted-pty' })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const activated = await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: 'persisted-pty',
        runtimeAdmittedPane: true,
        worktreeId: TEST_WORKTREE_ID
      })
    )
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
  })
})
