import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

const WORKTREE = `id:${TEST_WORKTREE_ID}`
const OTHER_WORKTREE_ID = `${TEST_REPO_ID}::/tmp/worktree-b`

function sleepingRecord(paneKey: string, worktreeId: string) {
  return {
    paneKey,
    tabId: paneKey.split(':')[0]!,
    worktreeId,
    agent: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: `resume-${paneKey}` },
    prompt: '',
    state: 'working' as const,
    capturedAt: 1,
    updatedAt: 1
  }
}

/** A host with no window whose one tab's pane is bound to `ptyId`. */
function headlessHost(ptyId: string, overrides: Partial<WorkspaceSessionState> = {}) {
  const harness = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
      },
      ...overrides
    })
  )
  const runtime = new OrcaRuntimeService(harness.runtimeStore)
  // As `orca serve` publishes at launch: a ready graph with no renderer panes.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const stopAndWait = vi.fn(async (stoppedPtyId: string) => {
    runtime.onPtyExit(stoppedPtyId, 0)
    return true
  })
  const kill = vi.fn(() => true)
  return { ...harness, runtime, stopAndWait, kill }
}

describe('terminal stops on a host with no window', () => {
  it('stops a daemon session no list has seen since the restart when closing all', async () => {
    const host = headlessHost('daemon-pty')
    host.runtime.setPtyController({
      write: () => true,
      kill: host.kill,
      stopAndWait: host.stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: 'daemon-pty', cwd: TEST_WORKTREE_PATH, title: 'zsh' }]
    })

    await expect(host.runtime.closeTerminalsForWorktree(WORKTREE)).resolves.toMatchObject({
      closed: 1,
      stopped: 1
    })
    expect(host.stopAndWait.mock.calls.map(([ptyId]) => ptyId)).toEqual(['daemon-pty'])
  })

  it("does not stop another pane's terminal that reuses a closed pane's saved local id", async () => {
    const host = headlessHost('1')
    host.runtime.setPtyController({
      write: () => true,
      kill: host.kill,
      stopAndWait: host.stopAndWait,
      getForegroundProcess: async () => null
    })
    // A relaunch without the daemon: a new terminal elsewhere got the closed pane's saved id.
    host.runtime.registerPty('1', OTHER_WORKTREE_ID, null, { tabId: 'other-tab', leafId: 'other' })

    await host.runtime.closeMobileSessionTab(WORKTREE, 'host-tab', { reason: 'user' })

    expect(host.getSession().tabsByWorktree[TEST_WORKTREE_ID] ?? []).toEqual([])
    expect(host.stopAndWait).not.toHaveBeenCalled()
    expect(host.kill).not.toHaveBeenCalled()
  })

  it("stops the closed pane's own live terminal", async () => {
    const host = headlessHost('pty-own')
    host.runtime.setPtyController({
      write: () => true,
      kill: host.kill,
      stopAndWait: host.stopAndWait,
      getForegroundProcess: async () => null
    })
    host.runtime.registerPty('pty-own', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })

    await host.runtime.closeMobileSessionTab(WORKTREE, 'host-tab', { reason: 'user' })

    await vi.waitFor(() =>
      expect(host.stopAndWait).toHaveBeenCalledWith('pty-own', expect.anything())
    )
  })

  it('clears resume records no pane names when closing all, keeping other workspaces', async () => {
    const unplaced = 'gone-tab:gone-leaf'
    const host = headlessHost('pty-own', {
      sleepingAgentSessionsByPaneKey: {
        [unplaced]: sleepingRecord(unplaced, TEST_WORKTREE_ID),
        'other-tab:other': sleepingRecord('other-tab:other', OTHER_WORKTREE_ID)
      },
      terminalPtyIncarnationsByPaneKey: {
        'host-tab:retired-leaf': 'incarnation-retired',
        'other-tab:other': 'incarnation-other'
      }
    })
    host.runtime.setPtyController({
      write: () => true,
      kill: host.kill,
      stopAndWait: host.stopAndWait,
      getForegroundProcess: async () => null
    })

    await host.runtime.closeTerminalsForWorktree(WORKTREE)

    expect(host.getSession().sleepingAgentSessionsByPaneKey).toEqual({
      'other-tab:other': expect.objectContaining({ worktreeId: OTHER_WORKTREE_ID })
    })
    expect(host.getSession().terminalPtyIncarnationsByPaneKey).toEqual({
      'other-tab:other': 'incarnation-other'
    })
  })
})
