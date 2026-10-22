// P4 (L80): with the switch on, a handle resolved for a pane whose terminal a replacement unbound
// learns that replacement, and only when its own terminal ended, the replacement is connected and
// bound at that pane now, and the workspace is the same.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('../../orca-runtime-test-mocks.spec')
await import('../../orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService, makePaneKey } = await import('../../orca-runtime-test-mocks.spec')
const { HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, TEST_REPO_ID, TEST_WORKTREE_ID, store } =
  await import('../../orca-runtime-test-fixtures.spec')
const { dropFromHostInventory, registerBoundPty } =
  await import('../../bind-first-pane.test-fixture')

function paneWithHandle(tabId: string) {
  const runtime = new OrcaRuntimeService(store)
  const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
  registerBoundPty(runtime, 'pty-old', TEST_WORKTREE_ID, null, { tabId, leafId: HEADLESS_LEAF_ID })
  const oldHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
  const createTerminal = vi.spyOn(runtime, 'createTerminal')
  const replace = () =>
    registerBoundPty(runtime, 'pty-new', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
  return { runtime, paneKey, oldHandle, createTerminal, replace }
}

describe('a stale handle of a replaced pane (switch on)', () => {
  it('learns the connected replacement once its own terminal ended', async () => {
    const { runtime, paneKey, oldHandle, createTerminal, replace } = paneWithHandle('tab-p4-ok')
    await dropFromHostInventory(runtime, 'pty-old')
    replace()

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, oldHandle)
    ).resolves.toMatchObject({ ptyId: 'pty-new' })
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('is refused for another workspace', async () => {
    const { runtime, paneKey, oldHandle, createTerminal, replace } = paneWithHandle('tab-p4-ws')
    await dropFromHostInventory(runtime, 'pty-old')
    replace()

    await expect(
      runtime.recoverTerminalPane(paneKey, `${TEST_REPO_ID}::/other`, oldHandle)
    ).rejects.toThrow('terminal_not_found')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('is refused while its own terminal still runs', async () => {
    const { runtime, paneKey, oldHandle, createTerminal, replace } = paneWithHandle('tab-p4-live')
    replace()

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, oldHandle)).rejects.toThrow(
      'terminal_not_found'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it("is refused for another pane's key, as after a move", async () => {
    const { runtime, oldHandle, createTerminal, replace } = paneWithHandle('tab-p4-move')
    await dropFromHostInventory(runtime, 'pty-old')
    replace()
    // Another pane's live terminal sits beside the stale handle's replaced pane.
    registerBoundPty(runtime, 'pty-other', TEST_WORKTREE_ID, null, {
      tabId: 'tab-p4-move',
      leafId: HEADLESS_SECOND_LEAF_ID
    })
    const otherPaneKey = makePaneKey('tab-p4-move', HEADLESS_SECOND_LEAF_ID)
    expect(runtime.resolveTerminalPane(otherPaneKey, TEST_WORKTREE_ID)).toMatchObject({
      ptyId: 'pty-other',
      connected: true
    })

    await expect(
      runtime.recoverTerminalPane(otherPaneKey, TEST_WORKTREE_ID, oldHandle)
    ).rejects.toThrow('terminal_not_found')
    expect(createTerminal).not.toHaveBeenCalled()
  })
})
