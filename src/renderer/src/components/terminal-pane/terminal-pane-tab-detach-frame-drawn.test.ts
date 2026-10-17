import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../../store/slices/store-cascades-test-harness'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'
import { LEAF_1, LEAF_2, splitLayout } from './terminal-pane-tab-detach-fixture'

const mocks = vi.hoisted(() => ({
  send: vi.fn<typeof sendLayoutCommandToOwner>(),
  callRuntimeRpc: vi.fn(async (..._args: unknown[]) => ({ ok: true, result: {} }))
}))
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/layout-owner-command', () => ({ sendLayoutCommandToOwner: mocks.send }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt'
const SOURCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MOVED = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const GROUP = 'group-1'

function row(id: string, ptyId: string, createdAt: number) {
  return {
    id,
    ptyId,
    worktreeId: WT,
    title: 'Terminal 1',
    defaultTitle: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt
  }
}

function entry(id: string, createdAt: number) {
  return {
    id,
    entityId: id,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal' as const,
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt
  }
}

/** The source tab split in two, and main's frame already showing the tab the pane moved into. */
function storeWithFrameDrawnMove() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt' })] },
    tabsByWorktree: { [WT]: [row(SOURCE, 'pty-left', 1), row(MOVED, 'pty-right', 2)] },
    unifiedTabsByWorktree: { [WT]: [entry(SOURCE, 1), entry(MOVED, 2)] },
    groupsByWorktree: {
      [WT]: [
        {
          id: GROUP,
          worktreeId: WT,
          activeTabId: SOURCE,
          tabOrder: [SOURCE, MOVED],
          recentTabIds: [SOURCE]
        }
      ]
    },
    activeGroupIdByWorktree: { [WT]: GROUP },
    terminalLayoutsByTabId: {
      [SOURCE]: {
        ...splitLayout(),
        ptyIdsByLeafId: { [LEAF_1]: 'pty-left', [LEAF_2]: 'pty-right' }
      },
      [MOVED]: {
        root: { type: 'leaf', leafId: LEAF_2 },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_2]: 'pty-right' }
      }
    }
  })
  return store
}

beforeEach(() => {
  mocks.send.mockReset()
  mocks.callRuntimeRpc.mockClear()
  vi.stubGlobal('window', { api: { pty: { moveLeafToNewTab: vi.fn() } } })
})

describe('a drag-out whose new tab main’s frame drew first', () => {
  it('shows the pane in the tab the frame drew instead of making a second one', async () => {
    const store = storeWithFrameDrawnMove()
    mocks.send.mockImplementation((_worktreeId, _command, handlers) => {
      handlers.apply({ tabId: MOVED, ptyId: 'pty-right' })
      return true
    })

    const moved = await detachTerminalPaneToTab({
      getStore: () => store.getState(),
      manager: {
        getPanes: () => [{ id: 1 }, { id: 2 }],
        getLeafId: (paneId: number) => (paneId === 2 ? LEAF_2 : LEAF_1),
        detachPaneForExternalMove: () => true
      },
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 2,
      sourceTabId: SOURCE,
      targetGroupId: GROUP,
      worktreeId: WT
    })

    expect(moved).toMatchObject({ leafId: LEAF_2, ptyId: 'pty-right', tab: { id: MOVED } })
    const state = store.getState()
    expect(state.tabsByWorktree[WT]!.map((tab) => tab.id)).toEqual([SOURCE, MOVED])
    expect(state.terminalLayoutsByTabId[SOURCE]!.root).toEqual({ type: 'leaf', leafId: LEAF_1 })
    expect(state.terminalLayoutsByTabId[MOVED]!.root).toEqual({ type: 'leaf', leafId: LEAF_2 })
    expect(state.activeTabIdByWorktree[WT]).toBe(MOVED)
  })
})
