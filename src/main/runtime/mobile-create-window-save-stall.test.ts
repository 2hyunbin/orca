/**
 * #7587 with the holder: a phone create whose window spawned the shell but never saved the tab
 * still resolves once the wait fails, from the live PTY, and the shell is not rolled back.
 */
import { expect, it, vi } from 'vitest'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService, electronMocks, ipcMain } =
  await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
const { createMobileCreateTestNotifier } =
  await import('./orca-runtime-test-scenario-builders.spec')

it('keeps a mobile-created terminal alive when the window never saves its tab', async () => {
  vi.useFakeTimers()
  try {
    const leafId = '66666666-6666-4666-8666-666666666666'
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-stall', title: 'Terminal' }
      )
    })
    webContents.send = send
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: true
    })
    let settled = false
    const settledCreate = create.finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    // The window's PTY spawn registers; its session save, which would add the tab, stalls.
    runtime.registerPty('pty-stall', TEST_WORKTREE_ID, null, { tabId: 'tab-stall', leafId })
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(11_000)
    const result = await settledCreate

    expect(result.tab).toMatchObject({
      type: 'terminal',
      parentTabId: 'tab-stall',
      leafId,
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
    expect(closeTerminal).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
