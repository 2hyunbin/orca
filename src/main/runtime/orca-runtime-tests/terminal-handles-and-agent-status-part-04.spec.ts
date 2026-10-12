import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  makeHeadlessTerminalLayout,
  makeWorkspaceSessionWithHeadlessTerminal,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

const terminalTab = (id: string, title: string, extra: Partial<TerminalTab> = {}): TerminalTab => ({
  id,
  ptyId: null,
  worktreeId: TEST_WORKTREE_ID,
  title,
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  ...extra
})

const unifiedTab = (
  id: string,
  entityId: string,
  contentType: 'terminal' | 'browser',
  label = id
): Tab => ({
  id,
  entityId,
  groupId: 'group-1',
  worktreeId: TEST_WORKTREE_ID,
  contentType,
  label,
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
})

// One terminal tab whose single pane has no PTY yet.
function sessionWithPendingTerminal(
  tabId: string,
  title: string,
  extra: Partial<TerminalTab> = {}
): WorkspaceSessionState {
  return sessionWith([unifiedTab(tabId, tabId, 'terminal', title)], tabId, {
    tabsByWorktree: { [TEST_WORKTREE_ID]: [terminalTab(tabId, title, extra)] },
    terminalLayoutsByTabId: {
      [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
    }
  })
}

// The host's saved session: these tabs in one group, `activeTabId` focused.
function sessionWith(
  tabs: Tab[],
  activeTabId: string,
  overrides: Partial<WorkspaceSessionState>
): WorkspaceSessionState {
  return makeWorkspaceSessionWithHeadlessTerminal({
    activeTabId,
    activeTabIdByWorktree: { [TEST_WORKTREE_ID]: activeTabId },
    unifiedTabs: { [TEST_WORKTREE_ID]: tabs },
    tabGroups: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'group-1',
          worktreeId: TEST_WORKTREE_ID,
          activeTabId,
          tabOrder: tabs.map((tab) => tab.id)
        }
      ]
    },
    activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-1' },
    ...overrides
  })
}

describe('OrcaRuntimeService', () => {
  it('does not let the active browser webContents steal session focus from terminals', async () => {
    store.setWorkspaceSession(
      sessionWith(
        [
          { ...unifiedTab('browser-unified-1', 'browser-workspace-1', 'browser'), sortOrder: 0 },
          { ...unifiedTab('terminal-tab', 'terminal-tab', 'terminal'), sortOrder: 1 }
        ],
        'terminal-tab',
        {
          tabsByWorktree: { [TEST_WORKTREE_ID]: [terminalTab('terminal-tab', 'Terminal 2')] },
          terminalLayoutsByTabId: {
            'terminal-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
          },
          browserTabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'browser-workspace-1',
                worktreeId: TEST_WORKTREE_ID,
                activePageId: 'browser-page-1',
                pageIds: ['browser-page-1'],
                url: 'https://stale.example/',
                title: 'Stale Browser',
                loading: false,
                faviconUrl: null,
                canGoBack: false,
                canGoForward: false,
                loadError: null,
                createdAt: 1
              }
            ]
          }
        }
      )
    )
    const runtime = new OrcaRuntimeService(store)
    const tabList = vi.fn(() => ({
      tabs: [
        {
          browserPageId: 'browser-page-1',
          index: 0,
          url: 'https://example.com/',
          title: 'Live Browser',
          active: true
        }
      ]
    }))
    runtime.setAgentBrowserBridge({ tabList } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.activeTabId).toBe(`terminal-tab::${HEADLESS_LEAF_ID}`)
    expect(result.activeTabType).toBe('terminal')
    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'browser',
        id: 'browser-unified-1',
        isActive: false,
        title: 'Live Browser'
      }),
      expect.objectContaining({
        type: 'terminal',
        id: `terminal-tab::${HEADLESS_LEAF_ID}`,
        isActive: true
      })
    ])
  })

  it('publishes terminal surface agent status for paired web clients', async () => {
    const leafId = HEADLESS_LEAF_ID
    const hostPaneKey = `tab-1:${leafId}`
    store.setWorkspaceSession(sessionWithPendingTerminal('tab-1', 'codex [working]'))
    // The hook server's status store is the source of a pane's agent status.
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: hostPaneKey,
          state: 'working',
          prompt: 'fix parity',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 1_000,
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `tab-1::${leafId}`,
        status: 'pending-handle',
        terminal: null,
        agentStatus: expect.objectContaining({
          state: 'working',
          prompt: 'fix parity',
          agentType: 'codex',
          paneKey: hostPaneKey
        })
      })
    ])
  })

  it('preserves authoritative OMP identity for Pi-compatible remote terminal snapshots', async () => {
    const hostPaneKey = `tab-1:${HEADLESS_LEAF_ID}`
    store.setWorkspaceSession(
      sessionWithPendingTerminal('tab-1', '\u280b Pi', { launchAgent: 'omp' })
    )
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: hostPaneKey,
          state: 'working',
          prompt: 'fix parity',
          agentType: 'pi',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 1_000,
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: '\u280b OMP',
        launchAgent: 'omp',
        agentStatus: expect.objectContaining({
          state: 'working',
          agentType: 'omp',
          paneKey: hostPaneKey,
          terminalTitle: '\u280b OMP'
        })
      })
    )
  })

  it('normalizes a remote OMP title', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-omp' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'omp',
      launchAgent: 'omp',
      title: 'OMP',
      activate: true
    })
    const spawnCall = spawn.mock.calls[0]?.[0]
    expect(spawnCall).toEqual(
      expect.objectContaining({
        tabId: expect.any(String),
        leafId: expect.any(String)
      })
    )
    const { tabId, leafId } = spawnCall as { tabId: string; leafId: string }

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: '\u280b π - tmp',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-omp',
          paneTitle: '\u280b π - tmp'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `${tabId}::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `${tabId}::${leafId}`,
              parentTabId: tabId,
              leafId,
              ptyId: 'pty-omp',
              title: '\u280b π - tmp',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: '\u280b OMP - tmp'
      })
    )
  })

  it('skips the foreground-process probe when the PTY launch agent is already known', async () => {
    // Why: foregroundAgent is only a fallback when launchAgent is unknown, so probing a launched agent burns a relay round-trip without changing the resolved owner.
    const getForegroundProcess = vi.fn(async () => 'omp')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-omp' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'omp',
      launchAgent: 'omp',
      title: 'OMP',
      activate: true
    })

    runtime.onPtyData('pty-omp', '\x1b]0;⠋ OMP\x07working\n', 100)
    runtime.onPtyData('pty-omp', '\x1b]0;OMP ready\x07idle\n', 200)

    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('probes the foreground process only on a status transition for unknown launch agents', async () => {
    const getForegroundProcess = vi.fn(async () => 'omp')
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    syncSinglePty(runtime, 'pty-bg')
    // Why: each probe dedups while in-flight; settle it before the next frame to prove the gate, not the dedup, suppresses extra probes.
    const settleProbe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

    // Two working frames (spinner churn) collapse to a single status transition.
    runtime.onPtyData('pty-bg', '\x1b]0;⠋ OMP\x07alpha\n', 100)
    runtime.onPtyData('pty-bg', '\x1b]0;⠊ OMP\x07bravo\n', 200)
    await settleProbe()
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)

    // Transition to idle is a second distinct status, so it probes again.
    runtime.onPtyData('pty-bg', '\x1b]0;OMP ready\x07charlie\n', 300)
    await settleProbe()
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)

    // A repeated idle frame is not a transition, so it does not probe again.
    runtime.onPtyData('pty-bg', '\x1b]0;OMP ready\x07delta\n', 400)
    await settleProbe()
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('normalizes Pi-compatible mobile session status to OMP for an unknown-launch foreground omp PTY', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi.fn(async () => 'omp')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'typed-omp-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(getForegroundProcess).toHaveBeenCalledWith('pty-typed-omp')
    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'OMP ready',
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'omp',
          terminalHandle: terminal.handle,
          terminalTitle: 'OMP ready'
        })
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('launchAgent')
  })

  it('preserves host metadata when terminal.create adopts a stable pane owner', async () => {
    const adoptStablePane = vi.fn().mockResolvedValue(null)
    const spawn = vi.fn(async (opts: { adoptedStablePane?: { owner: { handle?: string } } }) =>
      opts.adoptedStablePane
        ? {
            id: 'pty-stable-owner',
            isReattach: true,
            stablePaneOwner: {
              handle: opts.adoptedStablePane.owner.handle!,
              tabId: 'stable-owner-tab',
              leafId: HEADLESS_LEAF_ID
            }
          }
        : { id: 'pty-stable-owner' }
    )
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'in-process' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      adoptStablePane,
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const first = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'stable-owner-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Original owner',
      launchAgent: 'claude'
    })
    adoptStablePane.mockResolvedValueOnce({
      result: { id: 'pty-stable-owner', isReattach: true },
      owner: {
        handle: first.handle,
        tabId: 'stable-owner-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-stable-owner'
      }
    })

    const adopted = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'stable-owner-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Replacement intent',
      command: "claude 'replacement'",
      launchAgent: 'claude'
    })
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(adopted).toMatchObject({
      handle: first.handle,
      ptyId: 'pty-stable-owner',
      title: 'Original owner',
      isReattach: true
    })
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'stable-owner-tab',
        title: 'Original owner',
        launchAgent: 'claude'
      })
    ])
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      command: "claude 'replacement'",
      adoptedStablePane: expect.anything()
    })
    expect(spawn.mock.calls[1]?.[0]).not.toMatchObject({
      command: expect.stringContaining('--teammate-mode')
    })
  })

  it('releases a stable-pane claim when creation aborts before provider spawn', async () => {
    const releaseClaim = vi.fn()
    const spawn = vi.fn()
    // C5e relies on this: a disconnected client is refused before the pane is adopted.
    const adoptStablePane = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      claimStablePaneCreate: vi.fn(() => releaseClaim),
      adoptStablePane,
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const abort = new AbortController()
    abort.abort()

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'aborted-stable-pane',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')

    expect(spawn).not.toHaveBeenCalled()
    expect(adoptStablePane).not.toHaveBeenCalled()
    expect(releaseClaim).toHaveBeenCalledOnce()
  })

  // C5e relies on this: createTerminal checks the client again after adoption, before it spawns.
  it('refuses before spawning when the client disconnects during pane adoption', async () => {
    const abort = new AbortController()
    const spawn = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      adoptStablePane: vi.fn(async () => {
        abort.abort()
        return null
      }),
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'disconnected-during-adopt',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')

    expect(spawn).not.toHaveBeenCalled()
  })

  // C5e and C7 rely on this: createTerminal hands the client signal and the slept-worktree refusal to the spawn.
  it('passes the client signal and the slept-worktree refusal to the spawn', async () => {
    const spawn = vi.fn(async (_args: Record<string, unknown>) => {
      throw new Error('spawn_reached')
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      adoptStablePane: vi.fn(async () => null),
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const abort = new AbortController()

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'guards-forwarded',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal,
        refuseSleptWorktree: true
      })
    ).rejects.toThrow('spawn_reached')

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      signal: abort.signal,
      refuseSleptWorktree: true
    })
  })
})
