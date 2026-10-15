// A paired client opening a pane a terminal service restart left dead asks the window for the pane's
// own replacement (agent resume, old output) instead of spawning a bare shell here.
import { describe, expect, it, vi } from 'vitest'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

type WindowSeam = {
  getAuthoritativeWindow: () => {
    webContents: { send: (channel: string, payload: unknown) => void }
  }
}

async function makeRestartReplacedPane() {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  const spawn = vi.fn().mockResolvedValue({ id: 'persisted-pty' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const activate = () =>
    runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
  await activate()
  expect(spawn).toHaveBeenCalledOnce()
  const settle = runtime.intentionalPtyStops.mark('persisted-pty', 'replaced', null)
  await runtime.onPtyExit('persisted-pty', -1)
  settle(true)
  return { runtime, spawn, activate }
}

describe('opening a restart-replaced pane from a paired client', () => {
  it("asks the window for the pane's replacement and spawns nothing itself", async () => {
    const { runtime, spawn, activate } = await makeRestartReplacedPane()
    const send = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test replaces the runtime's window lookup with a stub of the one member it calls.
    ;(runtime as unknown as WindowSeam).getAuthoritativeWindow = () => ({ webContents: { send } })

    const result = await activate()

    expect(send).toHaveBeenCalledWith('terminal:requestTabMount', {
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'host-tab',
      ptyId: 'persisted-pty'
    })
    expect(spawn).toHaveBeenCalledOnce()
    expect(result.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
  })

  it('spawns the pane itself when no window can replace it', async () => {
    const { spawn, activate } = await makeRestartReplacedPane()

    await activate()

    expect(spawn).toHaveBeenCalledTimes(2)
  })
})
