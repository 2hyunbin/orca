import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import { GIT_KEY } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import { recordOpenedEditorTabInLayoutOwner } from '../store/slices/editor/tabs/editor-tab-layout-owner'
import { recordOpenedAgentSessionTabInLayoutOwner } from './agent-session-tab-layout-owner'
import { recordOpenedSimulatorTabInLayoutOwner } from '@/lib/simulator-tab-layout-owner'
import { endLayoutFramePositions } from './layout-frame-position'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

type Call = {
  command: { type: string; tabId?: string }
  answer: (r: LayoutApplyReply) => void
  fail: (error: Error) => void
}
const rpc = vi.hoisted((): { calls: Call[] } => ({ calls: [] }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (_target: unknown, _method: string, params: { command: { type: string } }) =>
    new Promise<LayoutApplyReply>((answer, fail) =>
      rpc.calls.push({ command: params.command, answer, fail })
    )
}))

type StreamDouble = {
  onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null
  onPosition: ((seq: number) => void) | null
}
const stream = vi.hoisted((): StreamDouble => ({ onFrame: null, onPosition: null }))
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
    _onStatus: unknown,
    onPosition: (seq: number) => void
  ) => {
    stream.onFrame = onFrame
    stream.onPosition = onPosition
    return { close: () => {} }
  }
}))

createStoreSessionMockApi()

function publishedOf(session: WorkspaceSessionState): PublishedWorkspaceLayout {
  const { layout } = loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext())
  return publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, 'local')
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let seq = 0
/** A frame main sent before it had the window's change: another tab got renamed. */
function sendStaleFrame(layout: PublishedWorkspaceLayout): void {
  const stale = structuredClone(layout)
  stale.tabs.find((tab) => tab.id === 'tab-unbound')!.customTitle = `renamed ${++seq}`
  stream.onFrame!({ type: 'workspace', key: GIT_KEY, layout: stale, seq })
  stream.onPosition!(seq)
}

async function boot() {
  const store = createTestStore()
  const session = localDesktopSession()
  await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(store)
  const before = publishedOf(session)
  stream.onFrame!({ type: 'snapshot', workspaces: [{ key: GIT_KEY, layout: before }], seq: ++seq })
  stream.onPosition!(seq)
  sync.start()
  await settle()
  /** Main's answer to the window's command, with the frame holding the window's change. */
  const answer = async (index: number, reply: LayoutApplyReply = okReply): Promise<void> => {
    const frame = publishedOf(buildWorkspaceSessionPayload(store.getState()))
    seq += 1
    stream.onFrame!({ type: 'workspace', key: GIT_KEY, layout: frame, seq })
    stream.onPosition!(seq)
    rpc.calls[index]!.answer({ ...reply, frameSeq: seq })
    await settle()
    await settle()
  }
  return { store, sync, before, answer }
}

const okReply: LayoutApplyReply = { ok: true, result: {} }

const tabBar = (store: ReturnType<typeof createTestStore>) =>
  store.getState().unifiedTabsByWorktree[GIT_KEY]!.map((tab) => tab.id)
const groupOrder = (store: ReturnType<typeof createTestStore>, groupId: string) =>
  store.getState().groupsByWorktree[GIT_KEY]!.find((group) => group.id === groupId)?.tabOrder

/** Draws a tab as the window's open does, before its recorder tells main. */
function drawTab(
  store: ReturnType<typeof createTestStore>,
  tab: Partial<Tab> & { id: string }
): Tab {
  const drawn: Tab = {
    entityId: tab.id,
    groupId: 'group-b',
    worktreeId: GIT_KEY,
    contentType: 'simulator',
    label: tab.id,
    customLabel: null,
    color: null,
    sortOrder: 9,
    createdAt: 1_700_000_900_000,
    ...tab
  }
  const state = store.getState()
  store.setState({
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [GIT_KEY]: [...state.unifiedTabsByWorktree[GIT_KEY]!, drawn]
    },
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [GIT_KEY]: state.groupsByWorktree[GIT_KEY]!.map((group) =>
        group.id === drawn.groupId ? { ...group, tabOrder: [...group.tabOrder, drawn.id] } : group
      )
    }
  })
  return drawn
}

beforeEach(() => {
  rpc.calls = []
})
afterEach(() => endLayoutFramePositions())

describe('a tab the window drew, closed or moved, with a frame from before main had it', () => {
  it('keeps a just-created terminal tab, then shows main’s copy', async () => {
    const { store, sync, before, answer } = await boot()
    const tab = store.getState().createTab(GIT_KEY)
    expect(rpc.calls[0]!.command).toMatchObject({ type: 'createTerminalTab', tabId: tab.id })

    sendStaleFrame(before)
    await settle()
    expect(tabBar(store)).toContain(tab.id)
    expect(store.getState().tabsByWorktree[GIT_KEY]!.map((row) => row.id)).toContain(tab.id)
    expect(store.getState().terminalLayoutsByTabId[tab.id]).toBeDefined()

    await answer(0)
    expect(tabBar(store)).toContain(tab.id)
    sync.close()
  })

  it('keeps a just-closed terminal tab closed', async () => {
    const { store, sync, before, answer } = await boot()
    store.getState().closeTab('tab-unbound')
    const close = rpc.calls.findIndex((call) => call.command.type === 'closeTabs')
    expect(close).toBeGreaterThanOrEqual(0)

    sendStaleFrame(before)
    await settle()
    expect(tabBar(store)).not.toContain('tab-unbound')
    expect(groupOrder(store, 'group-b')).not.toContain('tab-unbound')
    expect(store.getState().tabsByWorktree[GIT_KEY]!.map((row) => row.id)).not.toContain(
      'tab-unbound'
    )

    await answer(close)
    expect(tabBar(store)).not.toContain('tab-unbound')
    sync.close()
  })

  it.each([
    [
      'editor',
      (store: ReturnType<typeof createTestStore>) => {
        const file = {
          ...store.getState().openFiles[0]!,
          id: '/Users/dev/orca/src/new.ts',
          filePath: '/Users/dev/orca/src/new.ts',
          relativePath: 'src/new.ts'
        }
        store.setState({ openFiles: [...store.getState().openFiles, file] })
        const tab = drawTab(store, {
          id: 'editor:new',
          entityId: file.id,
          contentType: 'editor'
        })
        recordOpenedEditorTabInLayoutOwner(store.getState(), tab)
        return tab
      }
    ],
    [
      'chat',
      (store: ReturnType<typeof createTestStore>) => {
        const tab = drawTab(store, {
          id: 'agent-session-new',
          contentType: 'agent-session',
          agentSessionAgent: 'claude'
        })
        recordOpenedAgentSessionTabInLayoutOwner(store.getState(), tab)
        return tab
      }
    ],
    [
      'simulator',
      (store: ReturnType<typeof createTestStore>) => {
        const tab = drawTab(store, { id: 'simulator-new' })
        recordOpenedSimulatorTabInLayoutOwner(store.getState(), tab)
        return tab
      }
    ]
  ])('keeps a just-opened %s tab', async (_kind, open) => {
    const { store, sync, before } = await boot()
    const tab = open(store)
    expect(rpc.calls.length).toBeGreaterThan(0)

    sendStaleFrame(before)
    await settle()
    expect(tabBar(store)).toContain(tab.id)
    expect(groupOrder(store, 'group-b')).toContain(tab.id)
    if (tab.contentType === 'editor') {
      expect(store.getState().openFiles.map((file) => file.id)).toContain(tab.entityId)
    }
    sync.close()
  })

  it('keeps a just-opened browser tab and its page', async () => {
    const { store, sync, before } = await boot()
    const created = store.getState().createBrowserTab(GIT_KEY, 'https://example.com/', {
      title: 'Example'
    })
    const entry = store
      .getState()
      .unifiedTabsByWorktree[GIT_KEY]!.find((tab) => tab.entityId === created.id)!
    expect(rpc.calls.some((call) => call.command.type === 'openBrowserTab')).toBe(true)

    sendStaleFrame(before)
    await settle()
    expect(tabBar(store)).toContain(entry.id)
    expect(store.getState().browserTabsByWorktree[GIT_KEY]!.map((tab) => tab.id)).toContain(
      created.id
    )
    expect(store.getState().browserPagesByWorkspace[created.id]?.length).toBeGreaterThan(0)
    sync.close()
  })

  it('keeps a reorder the window made, and main’s order for the rest', async () => {
    const { store, sync, before, answer } = await boot()
    const order = groupOrder(store, 'group-a')!
    const reordered = order.toReversed()
    store.getState().reorderUnifiedTabs('group-a', reordered)
    const moves = rpc.calls.filter((call) => call.command.type === 'moveTab')
    expect(moves.length).toBeGreaterThan(0)

    sendStaleFrame(before)
    await settle()
    expect(groupOrder(store, 'group-a')).toEqual(reordered)

    for (let index = 0; index < rpc.calls.length; index += 1) {
      await answer(index)
    }
    expect(groupOrder(store, 'group-a')).toEqual(reordered)
    sync.close()
  })

  it.each([
    ['refuses it', (call: Call) => call.answer({ ok: false, code: 'wsl_move_in_progress' })],
    ['throws', (call: Call) => call.fail(new Error('layout_store_unavailable'))]
  ])('removes a just-created terminal tab, stopping it, when main %s', async (_case, refuse) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, sync, before } = await boot()
    const tab = store.getState().createTab(GIT_KEY)
    const closeTab = vi.spyOn(store.getState(), 'closeTab')
    sendStaleFrame(before)
    await settle()
    expect(tabBar(store)).toContain(tab.id)

    refuse(rpc.calls[0]!)
    await settle()
    await settle()
    expect(closeTab).toHaveBeenCalledWith(tab.id, { reason: 'cleanup' })
    expect(tabBar(store)).not.toContain(tab.id)
    expect(store.getState().tabsByWorktree[GIT_KEY]!.map((row) => row.id)).not.toContain(tab.id)
    expect(store.getState().terminalLayoutsByTabId[tab.id]).toBeUndefined()
    sync.close()
  })
})
