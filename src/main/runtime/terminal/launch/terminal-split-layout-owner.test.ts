import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../../orca-runtime-test-scenario-builders.spec'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { ProvisioningRuntime } from '../../orca-runtime-layout-owner-start-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const TAB_ID = 'host-tab'
const NEW_LEAF_ID = '22222222-2222-4222-8222-222222222222'

function graph() {
  return {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        title: 'shell',
        activeLeafId: HEADLESS_LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        leafId: HEADLESS_LEAF_ID,
        paneRuntimeId: 1,
        ptyId: 'pty-0',
        paneTitle: null
      }
    ]
  }
}

describe('a split of a pane the window draws, in a layout-owner build', () => {
  function setup() {
    const store = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
    const notifier = { ...createMobileCreateTestNotifier(vi.fn()), closeTerminalPane: vi.fn() }
    const runtime = new ProvisioningRuntime(store.runtimeStore)
    runtime.setNotifier(notifier)
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
        id: TEST_WORKTREE_ID,
        path: TEST_WORKTREE_PATH,
        connectionId: null,
        repo: null,
        folderWorkspace: null
      }))
    })
    const statusesSeen: unknown[] = []
    const spawn = vi.fn(async (args: { tabId?: string; leafId?: string }) => {
      statusesSeen.push(runtime.startStatusOf(`${args.tabId}:${args.leafId}`))
      return { id: `pty-split-${spawn.mock.calls.length}` }
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getCwd: async () => '/repo/src'
    })
    runtime.syncWindowGraph(1, graph())
    const handle = runtime.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, HEADLESS_LEAF_ID))
    const leafIds = () =>
      collectLayoutLeafIdsInOrder(store.getSession().terminalLayoutsByTabId[TAB_ID]!.root!)
    return {
      ...store,
      notifier,
      runtime,
      spawn,
      statusesSeen,
      handle: handle!,
      splitTerminal: vi.mocked(notifier.splitTerminal),
      leafIds
    }
  }

  it('main writes the pane and starts its terminal there, in the source pane’s folder; the window is not asked', async () => {
    const { runtime, handle, splitTerminal, leafIds, spawn, statusesSeen } = setup()

    const split = await runtime.splitTerminal(handle, {
      direction: 'vertical',
      command: 'make test'
    })

    expect(splitTerminal).not.toHaveBeenCalled()
    expect(leafIds()).toEqual([HEADLESS_LEAF_ID, split.leafId])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      tabId: TAB_ID,
      leafId: split.leafId,
      cwd: '/repo/src',
      command: 'make test',
      cols: 120,
      rows: 40
    })
    // Views see the pane as starting while it starts, so none starts its own; then it clears.
    expect(statusesSeen).toEqual([{ status: 'starting' }])
    expect(runtime.startStatusOf(makePaneKey(TAB_ID, split.leafId ?? ''))).toBeNull()
    expect(split.tabId).toBe(TAB_ID)
  })

  it('the window’s own split keeps its proposed pane id, folder and size', async () => {
    const { runtime, leafIds, spawn } = setup()

    const split = await runtime.splitTerminalPane(
      { worktreeId: TEST_WORKTREE_ID, tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
      {
        direction: 'horizontal',
        newLeafId: NEW_LEAF_ID,
        cwd: TEST_WORKTREE_PATH,
        initialSize: { cols: 90, rows: 20 },
        keepPaneOnStartFailure: true
      }
    )

    expect(split.leafId).toBe(NEW_LEAF_ID)
    expect(leafIds()).toEqual([HEADLESS_LEAF_ID, NEW_LEAF_ID])
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      leafId: NEW_LEAF_ID,
      cwd: TEST_WORKTREE_PATH,
      cols: 90,
      rows: 20
    })
  })

  it('a window split whose terminal fails to start keeps its pane, showing why', async () => {
    const { runtime, leafIds, spawn } = setup()
    spawn.mockRejectedValueOnce(new Error('shell not found'))

    await expect(
      runtime.splitTerminalPane(
        { worktreeId: TEST_WORKTREE_ID, tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
        { direction: 'vertical', newLeafId: NEW_LEAF_ID, keepPaneOnStartFailure: true }
      )
    ).rejects.toThrow('shell not found')

    expect(leafIds()).toEqual([HEADLESS_LEAF_ID, NEW_LEAF_ID])
    expect(runtime.startStatusOf(makePaneKey(TAB_ID, NEW_LEAF_ID))).toEqual({
      status: 'failed',
      reason: 'shell not found'
    })
  })

  it('a CLI split whose terminal fails to start leaves no pane, and the CLI hears why', async () => {
    const { runtime, handle, leafIds, spawn, notifier } = setup()
    spawn.mockRejectedValueOnce(new Error('shell not found'))

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).rejects.toThrow(
      'shell not found'
    )

    expect(leafIds()).toEqual([HEADLESS_LEAF_ID])
    expect(notifier.closeTerminalPane).not.toHaveBeenCalled()
  })

  it('starts nothing when main cannot write the pane', async () => {
    const { runtime, runtimeStore, handle, splitTerminal, leafIds, spawn } = setup()
    Reflect.set(
      runtimeStore,
      'admitTerminalPane',
      vi.fn(async () => 'pane_not_found')
    )

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).rejects.toThrow(
      'terminal_split_source_not_found'
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(splitTerminal).not.toHaveBeenCalled()
    expect(leafIds()).toEqual([HEADLESS_LEAF_ID])
  })

  it('starts nothing for a pane-named split of a tab main does not hold', async () => {
    const { runtime, spawn } = setup()

    await expect(
      runtime.splitTerminalPane(
        { worktreeId: TEST_WORKTREE_ID, tabId: 'tab-elsewhere', leafId: HEADLESS_LEAF_ID },
        { direction: 'vertical' }
      )
    ).rejects.toThrow('terminal_split_source_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })
})
