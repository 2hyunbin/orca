// Layout-owner build: a paired desktop's Reopen of a pane main holds for a newer build's terminal
// service stops that service, then starts the pane; its published status clears as it binds.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NEWER_DAEMON_HOLD_ERROR } from '../../shared/newer-daemon-hold'
import type * as DaemonHoldModule from '../daemon/daemon-newer-protocol-hold'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
const daemonHold = vi.hoisted(() => ({ reopen: vi.fn() }))
vi.mock('../daemon/daemon-newer-protocol-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonHoldModule>()),
  reopenNewerDaemonTerminals: daemonHold.reopen
}))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const PANE = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }

/** A windowless host whose first start of the pane is held for a newer build. */
async function heldPaneRuntime() {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new StatusProbe(runtimeStore)
  const spawn = vi.fn(async (_args: { sessionId?: string }) => ({ id: 'pty-reopened' }))
  spawn.mockRejectedValueOnce(new Error(NEWER_DAEMON_HOLD_ERROR))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  await expect(runtime.ensureRestoredPaneStarted(PANE)).rejects.toThrow(NEWER_DAEMON_HOLD_ERROR)
  return { runtime, spawn }
}

const PANE_KEY = `${PANE.tabId}:${PANE.leafId}`

/** The start status main publishes on the pane. */
class StatusProbe extends OrcaRuntimeService {
  startStatusOf(paneKey: string) {
    return this.paneStartStatuses?.peek(paneKey)?.status
  }
}

beforeEach(() => {
  daemonHold.reopen.mockReset()
  daemonHold.reopen.mockResolvedValue({ reopened: true })
})

describe("a paired desktop's Reopen of a held pane (layout-owner build)", () => {
  it('stops the newer build, then starts the pane, whose held status clears', async () => {
    const { runtime, spawn } = await heldPaneRuntime()
    expect(runtime.startStatusOf(PANE_KEY)).toBe('held')

    await expect(runtime.reopenHeldTerminalPanes([PANE])).resolves.toEqual({ reopened: true })

    expect(daemonHold.reopen).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'persisted-pty' }))
    expect(runtime.startStatusOf(PANE_KEY)).toBeUndefined()
  })

  it('starts nothing and stays held while the newer build may still run', async () => {
    const { runtime, spawn } = await heldPaneRuntime()
    daemonHold.reopen.mockResolvedValue({ reopened: false })

    await expect(runtime.reopenHeldTerminalPanes([PANE])).resolves.toEqual({ reopened: false })

    expect(spawn).toHaveBeenCalledOnce()
    expect(runtime.startStatusOf(PANE_KEY)).toBe('held')
  })

  it('stops nothing for a pane main does not hold', async () => {
    const { runtime, spawn } = await heldPaneRuntime()

    await expect(
      runtime.reopenHeldTerminalPanes([{ ...PANE, tabId: 'other-tab' }])
    ).resolves.toEqual({ reopened: true })

    expect(daemonHold.reopen).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
  })
})
