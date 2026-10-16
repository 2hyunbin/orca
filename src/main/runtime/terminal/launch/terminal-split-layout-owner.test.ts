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

function graph(leafIds: string[], unboundLeafIds: string[] = []) {
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
    leaves: [...leafIds, ...unboundLeafIds].map((leafId, index) => ({
      tabId: TAB_ID,
      worktreeId: TEST_WORKTREE_ID,
      leafId,
      paneRuntimeId: index + 1,
      ptyId: index < leafIds.length ? `pty-${index}` : null,
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

  it.each([
    ['holds the pane while its terminal is still starting', 'graph'],
    ['recorded the pane before its graph says so', 'record']
  ] as const)('keeps a pane main awaited when the window %s', async (_, shownBy) => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const notifier = createMobileCreateTestNotifier(vi.fn())
    const splitTerminal = vi.mocked(notifier.splitTerminal)
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setNotifier(notifier)
    runtime.syncWindowGraph(1, graph([HEADLESS_LEAF_ID]))
    const handle = runtime.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, HEADLESS_LEAF_ID))

    vi.useFakeTimers()
    try {
      const split = runtime.splitTerminal(handle!, { direction: 'vertical' })
      const rejected = expect(split).rejects.toThrow('Timed out waiting for split pane handle')
      await vi.waitFor(() => expect(splitTerminal).toHaveBeenCalledTimes(1))
      const newLeafId = splitTerminal.mock.calls[0]![2]!.newLeafId!
      if (shownBy === 'graph') {
        // The window's session publication lists the new pane; this graph carries none.
        Reflect.set(runtime, 'isMobileSessionSurfaceMembershipAllowed', () => true)
        runtime.syncWindowGraph(1, graph([HEADLESS_LEAF_ID], [newLeafId]))
      } else {
        // This fixture store has no layout.apply; main notes the record before applying it.
        await runtime
          .applyLayoutCommand({
            type: 'splitPane',
            workspace: TEST_WORKTREE_ID,
            tabId: TAB_ID,
            leafId: HEADLESS_LEAF_ID,
            direction: 'vertical',
            newLeafId
          })
          .catch(() => {})
      }

      await vi.advanceTimersByTimeAsync(11_000)
      await rejected
      expect(
        collectLayoutLeafIdsInOrder(getSession().terminalLayoutsByTabId[TAB_ID]!.root!)
      ).toEqual([HEADLESS_LEAF_ID, newLeafId])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    // [case, how the split goes, whether the record may write the pane]
    ['took it back unshown', 'taken-back', true],
    ['still holds it', 'held', false],
    ['found it gone when taking it back (a client closed it)', 'closed-meanwhile', false],
    ['split as today, writing nothing', 'unwritten', true]
  ] as const)(
    'lets the window’s record of a split main asked for write it when main %s',
    async (_, path, writes) => {
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const applyLayoutCommand = vi.fn(async () => ({ ok: true as const, result: {} }))
      Reflect.set(runtimeStore, 'applyLayoutCommand', applyLayoutCommand)
      if (path === 'closed-meanwhile') {
        Reflect.set(
          runtimeStore,
          'withdrawTerminalPane',
          vi.fn(async () => 'pane_not_found')
        )
      }
      if (path === 'unwritten') {
        Reflect.set(
          runtimeStore,
          'admitTerminalPane',
          vi.fn(async () => 'pane_not_found')
        )
      }
      const notifier = createMobileCreateTestNotifier(vi.fn())
      const splitTerminal = vi.mocked(notifier.splitTerminal)
      const runtime = new OrcaRuntimeService(runtimeStore)
      runtime.setNotifier(notifier)
      runtime.syncWindowGraph(1, graph([HEADLESS_LEAF_ID]))
      const handle = runtime.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, HEADLESS_LEAF_ID))

      vi.useFakeTimers()
      try {
        const split = runtime.splitTerminal(handle!, { direction: 'vertical' })
        const rejected = expect(split).rejects.toThrow()
        await vi.waitFor(() => expect(splitTerminal).toHaveBeenCalledTimes(1))
        const newLeafId = splitTerminal.mock.calls[0]![2]!.newLeafId!
        if (path !== 'held') {
          await vi.advanceTimersByTimeAsync(11_000)
          await rejected
        }
        const record = {
          type: 'splitPane',
          workspace: TEST_WORKTREE_ID,
          tabId: TAB_ID,
          leafId: HEADLESS_LEAF_ID,
          direction: 'vertical',
          newLeafId,
          mainAsked: true
        } as const

        await runtime.applyLayoutCommand(record)

        const { mainAsked: _mainAsked, ...plain } = record
        expect(applyLayoutCommand).toHaveBeenLastCalledWith(
          writes ? plain : record,
          expect.anything()
        )
        if (path === 'held') {
          await vi.advanceTimersByTimeAsync(11_000)
          await rejected
        }
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('holds a record that lands while main takes the split back, then writes it', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const applyLayoutCommand = vi.fn(async () => ({ ok: true as const, result: {} }))
    const withdrawal = Promise.withResolvers<null>()
    Reflect.set(runtimeStore, 'applyLayoutCommand', applyLayoutCommand)
    Reflect.set(
      runtimeStore,
      'withdrawTerminalPane',
      vi.fn(() => withdrawal.promise)
    )
    const notifier = createMobileCreateTestNotifier(vi.fn())
    const splitTerminal = vi.mocked(notifier.splitTerminal)
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setNotifier(notifier)
    runtime.syncWindowGraph(1, graph([HEADLESS_LEAF_ID]))
    const handle = runtime.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, HEADLESS_LEAF_ID))

    vi.useFakeTimers()
    try {
      const split = runtime.splitTerminal(handle!, { direction: 'vertical' })
      const rejected = expect(split).rejects.toThrow()
      await vi.waitFor(() => expect(splitTerminal).toHaveBeenCalledTimes(1))
      const newLeafId = splitTerminal.mock.calls[0]![2]!.newLeafId!
      await vi.advanceTimersByTimeAsync(11_000)
      const record = {
        type: 'splitPane',
        workspace: TEST_WORKTREE_ID,
        tabId: TAB_ID,
        leafId: HEADLESS_LEAF_ID,
        direction: 'vertical',
        newLeafId,
        mainAsked: true
      } as const

      const recorded = runtime.applyLayoutCommand(record)
      await vi.advanceTimersByTimeAsync(0)
      expect(applyLayoutCommand).not.toHaveBeenCalled()

      withdrawal.resolve(null)
      await recorded
      await rejected
      const { mainAsked: _mainAsked, ...plain } = record
      expect(applyLayoutCommand).toHaveBeenLastCalledWith(plain, expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the record write a split main made without writing it (no partition for the tab yet)', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const applyLayoutCommand = vi.fn(async () => ({ ok: true as const, result: {} }))
    Reflect.set(runtimeStore, 'applyLayoutCommand', applyLayoutCommand)
    const notifier = createMobileCreateTestNotifier(vi.fn())
    const splitTerminal = vi.mocked(notifier.splitTerminal)
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setNotifier(notifier)
    runtime.syncWindowGraph(1, graph([HEADLESS_LEAF_ID]))
    const handle = runtime.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, HEADLESS_LEAF_ID))
    const hostIdsForTab = Reflect.get(runtime, 'getWorkspaceSessionHostIdsForTab')
    Reflect.set(runtime, 'getWorkspaceSessionHostIdsForTab', () => [])

    vi.useFakeTimers()
    try {
      const split = runtime.splitTerminal(handle!, { direction: 'vertical' })
      const rejected = expect(split).rejects.toThrow()
      await vi.waitFor(() => expect(splitTerminal).toHaveBeenCalledTimes(1))
      const newLeafId = splitTerminal.mock.calls[0]![2]!.newLeafId!
      Reflect.set(runtime, 'getWorkspaceSessionHostIdsForTab', hostIdsForTab)
      const record = {
        type: 'splitPane',
        workspace: TEST_WORKTREE_ID,
        tabId: TAB_ID,
        leafId: HEADLESS_LEAF_ID,
        direction: 'vertical',
        newLeafId,
        mainAsked: true
      } as const

      await runtime.applyLayoutCommand(record)

      const { mainAsked: _mainAsked, ...plain } = record
      expect(applyLayoutCommand).toHaveBeenLastCalledWith(plain, expect.anything())
      await vi.advanceTimersByTimeAsync(11_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})
