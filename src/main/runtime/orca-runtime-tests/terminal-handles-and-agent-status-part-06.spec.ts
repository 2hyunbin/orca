import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

const leafId = HEADLESS_LEAF_ID

// The host's saved session holds terminal tab `tab-1` whose one pane is bound to `ptyId`.
function seedTerminalTab(ptyId: string, title = 'Terminal 1'): void {
  store.setWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'tab-1' },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'tab-1',
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title,
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: { 'tab-1': makeHeadlessTerminalLayout({ [leafId]: ptyId }) }
    })
  )
}

function syncPane(
  runtime: InstanceType<typeof OrcaRuntimeService>,
  ptyId: string,
  paneTitle?: string
): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        title: 'claude working',
        activeLeafId: leafId,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        leafId,
        paneRuntimeId: 1,
        ptyId,
        ...(paneTitle ? { paneTitle } : {})
      }
    ]
  })
}

describe('OrcaRuntimeService', () => {
  it('keeps saved PTY bindings pending until the runtime knows the PTY is connected', async () => {
    seedTerminalTab('daemon-pty-1')
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `tab-1::${leafId}`,
        ptyId: 'daemon-pty-1',
        parentTabId: 'tab-1',
        leafId,
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('refreshes daemon PTY liveness before publishing mobile session tabs', async () => {
    seedTerminalTab('daemon-pty-1')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'daemon-pty-1', cwd: TEST_WORKTREE_PATH, title: 'daemon shell' }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `tab-1::${leafId}`,
        ptyId: 'daemon-pty-1',
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
    ])
  })

  it('does not invalidate a newly spawned SSH pane from an overlapping stale process list', async () => {
    const ptyId = 'ssh:ssh-1@@pty-new'
    seedTerminalTab(ptyId, 'SSH terminal')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [],
      hasPty: (candidate) => candidate === ptyId
    })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'tab-1',
      leafId
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({ ptyId, status: 'ready', terminal: expect.any(String) })
    ])
  })

  it('reattaches mobile terminal surfaces from saved PTY bindings when the PTY is connected', async () => {
    seedTerminalTab('daemon-pty-1')
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    syncPane(runtime, 'daemon-pty-1')
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `tab-1::${leafId}`,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
    ])
    expect(runtime.resolveLeafForHandle((result.tabs[0] as { terminal: string }).terminal)).toEqual(
      { ptyId: 'daemon-pty-1' }
    )
  })
})
