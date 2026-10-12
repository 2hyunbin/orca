import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  antigravityPromptBeforeModelReadyScreen,
  antigravityReadyScreen,
  makeHeadlessTerminalLayout,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

// The host's saved session holds terminal tab `tab-1` with these pane bindings.
function seedTerminalTab(
  ptyIdsByLeafId: Record<string, string | undefined>,
  overrides: Partial<WorkspaceSessionState> = {}
): void {
  store.setWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'tab-1' },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'tab-1',
            ptyId: Object.values(ptyIdsByLeafId).find(Boolean) ?? null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: { 'tab-1': makeHeadlessTerminalLayout(ptyIdsByLeafId) },
      ...overrides
    })
  )
}

describe('OrcaRuntimeService', () => {
  it('allows non-Claude foreground agents after preserved Claude agents management evidence', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex',
      listProcesses: async () => [{ id: 'pty-bg', cwd: TEST_WORKTREE_PATH, title: 'zsh' }]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    await runtime.getWorktreePs()

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('does not let stale PTY status override a fresh neutral PTY title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'Claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;Claude working\x07', 100)
    runtime.onPtyData('pty-bg', '\x1b]0;zsh\x07', 101)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not use stale runtime-created PTY status when a neutral PTY title exists', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'zsh'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastAgentStatus: 'working' | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastAgentStatus = 'working'
    runtime.setPtyController(null)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('recognizes ready prompt evidence even with a stale Claude agents title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    runtime.onPtyData(
      'pty-bg',
      ['OpenAI Codex', 'Model: gpt-5.4', 'Directory: /tmp/worktree-a'].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes runtime-created Codex PTY handles from the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      ['OpenAI Codex', 'Model: gpt-5.4', 'Directory: /tmp/worktree-a'].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes runtime-created Antigravity PTY handles from the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData('pty-bg', antigravityReadyScreen(), 100)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes Antigravity ready tails with the prompt before the model line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData('pty-bg', antigravityPromptBeforeModelReadyScreen(), 100)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes live leaf Antigravity terminals from the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
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
          paneTitle: null
        }
      ]
    })
    runtime.onPtyData('pty-1', antigravityReadyScreen(), 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
  })

  it('does not recognize partial Antigravity startup output as an agent', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        'Antigravity CLI 1.0.3',
        'user@example.com (Antigravity Business)',
        'Gemini 3.5 Flash (High)'
      ].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('recognizes a later Antigravity header with a prompt but no model line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        antigravityReadyScreen(),
        '\nAntigravity CLI 1.0.4\n',
        'user@example.com (Antigravity Business)\n',
        '~/orca/workspaces/orca/agy-dispatch-issue\n',
        '>\n'
      ].join(''),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('uses the latest Antigravity header when checking readiness', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        antigravityReadyScreen(),
        '\nAntigravity CLI 1.0.4\n',
        'user@example.com (Antigravity Business)\n',
        'Gemini 4 Experimental (High)\n',
        'Do you trust this workspace directory?\n'
      ].join(''),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('recognizes Antigravity prompts written as the current partial line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        'Antigravity CLI 1.0.3\n',
        'user@example.com (Antigravity Business)\n',
        'Gemini 3.5 Flash (High)\n',
        '~/orca/workspaces/orca/agy-dispatch-issue\n'
      ].join(''),
      100
    )
    runtime.onPtyData('pty-bg', '   >   ', 101)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('does not classify agy workspace paths or titles without the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: '/tmp/agy-workspace',
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
          paneTitle: '/tmp/agy-workspace'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'cd /tmp/agy-workspace\n', 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('keeps mobile terminal surfaces visible while their leaf handle is pending', async () => {
    seedTerminalTab({ [HEADLESS_LEAF_ID]: undefined })
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `tab-1::${HEADLESS_LEAF_ID}`,
        parentTabId: 'tab-1',
        leafId: HEADLESS_LEAF_ID,
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('keeps mobile terminal surfaces pending while a live leaf has no PTY', async () => {
    seedTerminalTab({ [HEADLESS_LEAF_ID]: undefined })
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: null,
          paneTitle: 'Terminal 1'
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `tab-1::${HEADLESS_LEAF_ID}`,
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('selects a visible active pane when terminal visual layout prunes a stale leaf', async () => {
    // The saved focus is the first (stale) pane; only the second has a live PTY.
    seedTerminalTab(
      { [HEADLESS_LEAF_ID]: undefined, [HEADLESS_SECOND_LEAF_ID]: 'pty-2' },
      {
        unifiedTabs: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'tab-1',
              entityId: 'tab-1',
              groupId: 'group-1',
              worktreeId: TEST_WORKTREE_ID,
              contentType: 'terminal',
              label: 'Split terminal',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        tabGroups: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'group-1',
              worktreeId: TEST_WORKTREE_ID,
              activeTabId: 'missing-tab',
              tabOrder: ['missing-tab', 'tab-1']
            }
          ]
        },
        activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-1' }
      }
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Split terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_SECOND_LEAF_ID,
          paneRuntimeId: 2,
          ptyId: 'pty-2',
          paneTitle: 'Live pane'
        }
      ]
    })

    const result = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(result.visualLayouts).toMatchObject([
      {
        worktreeId: TEST_WORKTREE_ID,
        root: {
          type: 'group',
          activeTabId: 'tab-1',
          tabs: [
            {
              tabId: 'tab-1',
              activeLeafId: HEADLESS_SECOND_LEAF_ID,
              panes: {
                type: 'terminal',
                leafId: HEADLESS_SECOND_LEAF_ID,
                active: true
              }
            }
          ]
        }
      }
    ])
  })

  it('omits stale browser session tabs that no longer have live webContents', async () => {
    const browserWorkspace = (name: string, title: string, url: string) => ({
      id: `browser-workspace-${name}`,
      worktreeId: TEST_WORKTREE_ID,
      activePageId: `browser-page-${name}`,
      pageIds: [`browser-page-${name}`],
      url,
      title,
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    })
    const browserTab = (name: string, sortOrder: number) => ({
      id: `browser-unified-${name}`,
      entityId: `browser-workspace-${name}`,
      groupId: 'group-1',
      worktreeId: TEST_WORKTREE_ID,
      contentType: 'browser' as const,
      label: name,
      customLabel: null,
      color: null,
      sortOrder,
      createdAt: 1
    })
    store.setWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeTabId: null,
        activeTabIdByWorktree: {},
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        browserTabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            browserWorkspace('stale', 'Dead Browser', 'about:blank'),
            browserWorkspace('live', 'Stale Title', 'https://stale.example/')
          ]
        },
        unifiedTabs: { [TEST_WORKTREE_ID]: [browserTab('stale', 0), browserTab('live', 1)] },
        tabGroups: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'group-1',
              worktreeId: TEST_WORKTREE_ID,
              activeTabId: 'browser-unified-stale',
              tabOrder: ['browser-unified-stale', 'browser-unified-live']
            }
          ]
        },
        activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-1' }
      })
    )
    const runtime = new OrcaRuntimeService(store)
    const tabList = vi.fn(() => ({
      tabs: [
        {
          browserPageId: 'browser-page-live',
          index: 0,
          url: 'https://live.example/',
          title: 'Live Browser',
          active: true
        }
      ]
    }))
    runtime.setAgentBrowserBridge({ tabList } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(tabList).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'browser',
        id: 'browser-unified-live',
        browserPageId: 'browser-page-live',
        url: 'https://live.example/',
        title: 'Live Browser',
        isActive: true
      })
    ])
    expect(result.activeTabId).toBe('browser-unified-live')
    expect(result.activeTabType).toBe('browser')
  })
})
