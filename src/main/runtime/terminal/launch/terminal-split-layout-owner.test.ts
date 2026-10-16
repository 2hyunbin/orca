import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, makePaneKey } from '../../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../../orca-runtime-test-scenario-builders.spec'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const TAB_ID = 'host-tab'

function graph(leafIds: string[]) {
  return {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        title: 'shell',
        activeLeafId: leafIds[0]!,
        layout: null
      }
    ],
    leaves: leafIds.map((leafId, index) => ({
      tabId: TAB_ID,
      worktreeId: TEST_WORKTREE_ID,
      leafId,
      paneRuntimeId: index + 1,
      ptyId: `pty-${index}`,
      paneTitle: null
    }))
  }
}

describe('a split of a pane the window draws, in a layout-owner build', () => {
  it('writes the new pane in main before the window mounts it, and takes back one never mounted', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const notifier = createMobileCreateTestNotifier(vi.fn())
    const splitTerminal = vi.mocked(notifier.splitTerminal)
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setNotifier(notifier)
    runtime.syncWindowGraph(1, graph([HEADLESS_LEAF_ID]))
    const handle = runtime.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, HEADLESS_LEAF_ID))
    const leafIds = () =>
      collectLayoutLeafIdsInOrder(getSession().terminalLayoutsByTabId[TAB_ID]!.root!)

    vi.useFakeTimers()
    try {
      const split = runtime.splitTerminal(handle!, { direction: 'vertical' })
      const rejected = expect(split).rejects.toThrow('Timed out waiting for split pane handle')
      await vi.waitFor(() => expect(splitTerminal).toHaveBeenCalledTimes(1))
      const newLeafId = splitTerminal.mock.calls[0]![2]!.newLeafId!
      // Main holds the pane before the window has mounted it.
      expect(leafIds()).toEqual([HEADLESS_LEAF_ID, newLeafId])

      await vi.advanceTimersByTimeAsync(11_000)
      await rejected
      expect(leafIds()).toEqual([HEADLESS_LEAF_ID])
    } finally {
      vi.useRealTimers()
    }
  })
})
