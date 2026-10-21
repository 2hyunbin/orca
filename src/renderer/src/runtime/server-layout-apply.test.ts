import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as ResolveOwnerModule from '@/lib/resolve-owner'
import type * as RuntimeRpcClientModule from './runtime-rpc-client'
import type * as FrameDrawnModule from './web-session-tabs-sync/frame-drawn-server-workspaces'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import {
  _resetLayoutFramePositionForTests,
  beginLayoutFramePositions,
  noteLayoutFramePosition
} from './layout-frame-position'
import { sendLayoutApply, type WindowLayoutCommand } from './layout-apply-send'
import { mainLayoutFrameSender } from './main-loaded-layout-frames.test-fixture'
import { SERVER_ROUTED_LAYOUT_COMMANDS } from './server-layout-apply'
import {
  CAPABLE,
  ENV,
  HOST_GROUP,
  LEAF_ID,
  SECOND_LEAF_ID,
  WT,
  createFakeLayoutStreams,
  createServerHarness,
  senderSnapshot,
  serverLayout,
  serverTerminalTab,
  settle,
  type TestStore
} from './server-layout-frames.test-fixture'
import { resetFrameDrawnServerWorkspacesForTests } from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { resetMirroredTerminalHandlesForTests } from './web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

type Subscribe = (...args: never[]) => { close: () => void }
type Sent = { target: RuntimeClientTarget; params: unknown }
const hoisted = vi.hoisted(
  (): {
    owners: Map<string, string>
    resync: Mock<(environmentId: string, worktreeId: string) => Promise<void>>
    subscribe: Subscribe | null
    sent: Sent[]
    reply: () => Promise<LayoutApplyReply>
  } => ({
    owners: new Map(),
    resync: vi.fn(),
    subscribe: null,
    sent: [],
    reply: async () => ({ ok: true, result: {} })
  })
)

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (...args: never[]) => hoisted.subscribe!(...args)
}))
vi.mock('./web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (_state: unknown, key: string) =>
    hoisted.owners.get(key) ?? null
}))
vi.mock('@/lib/resolve-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof ResolveOwnerModule>()),
  runtimeEnvironmentIdUnlessTwin: (_state: unknown, key: string) => hoisted.owners.get(key) ?? null
}))
vi.mock('./web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return {
    ...actual,
    callRuntimeRpc: (target: RuntimeClientTarget, method: string, params?: unknown) => {
      if (method !== 'layout.apply') {
        return actual.callRuntimeRpc(target, method, params)
      }
      hoisted.sent.push({ target, params })
      return hoisted.reply()
    }
  }
})

createStoreSessionMockApi()

const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe

const TAB_1 = toWebTerminalSurfaceTabId('host-tab-1')
const TAB_2 = toWebTerminalSurfaceTabId('host-tab-2')
// The server's tab-bar ids differ from its terminals' ids: the join must not derive one from the other.
const TWO_TABS: PublishedWorkspaceLayout = (() => {
  const tabs = [
    { ...serverTerminalTab('host-tab-1', LEAF_ID, 'server-pty-1'), id: 'bar-1' },
    { ...serverTerminalTab('host-tab-2', SECOND_LEAF_ID, 'server-pty-2'), id: 'bar-2' }
  ]
  return { ...serverLayout(tabs), groups: [{ id: HOST_GROUP, tabIds: ['bar-1', 'bar-2'] }] }
})()

const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

async function drawnByServer(layout = TWO_TABS) {
  const store = mirroredStore()
  install(store)
  setServers(store, [CAPABLE])
  const stream = streams.openTo(ENV)
  const frames = mainLayoutFrameSender()
  streams.send(stream, senderSnapshot(frames, { [WT]: layout }, 1))
  await settle()
  return { store, stream, frames }
}

function send(store: TestStore, command: WindowLayoutCommand) {
  const handlers = { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn() }
  const taken = sendLayoutApply(store.getState(), WT, command, handlers)
  return { taken, handlers }
}

const orderOf = (store: TestStore) =>
  store.getState().groupsByWorktree[WT]?.find((group) => group.id === HOST_GROUP)?.tabOrder

beforeEach(() => {
  hoisted.owners.clear()
  hoisted.sent.length = 0
  hoisted.reply = async () => ({ ok: true, result: {} })
  hoisted.resync.mockReset().mockResolvedValue(undefined)
  streams.all.length = 0
  resetWebSessionTabsSyncTestState()
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(uninstallAll)

describe('a layout intent for a workspace a server’s frames draw', () => {
  it('goes to that server’s main under its ids, and shows once that server’s frame is in', async () => {
    const { store, stream, frames } = await drawnByServer()
    expect(orderOf(store)).toEqual([TAB_1, TAB_2])
    hoisted.reply = async () => ({ ok: true, result: { tabId: 'bar-2' }, frameSeq: 2 })
    // This window's own main is far ahead: its frames must not release a server's reply.
    beginLayoutFramePositions()
    noteLayoutFramePosition(50)

    const { taken, handlers } = send(store, {
      type: 'moveTab',
      tabId: TAB_2,
      toGroupId: HOST_GROUP,
      index: 0
    })
    await settle()

    expect(taken).toBe(true)
    expect(hoisted.sent).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: {
          command: {
            type: 'moveTab',
            tabId: 'bar-2',
            toGroupId: HOST_GROUP,
            index: 0,
            workspace: WT
          }
        }
      }
    ])
    expect(handlers.apply).not.toHaveBeenCalled()

    const moved = structuredClone(TWO_TABS)
    moved.groups[0]!.tabIds = ['bar-2', 'bar-1']
    streams.send(stream, frames.records(WT, moved))
    await settle()

    expect(orderOf(store)).toEqual([TAB_2, TAB_1])
    expect(handlers.apply).toHaveBeenCalledWith({ tabId: TAB_2 }, { framesKey: ENV, routed: true })
    expect(handlers.asToday).not.toHaveBeenCalled()
  })

  it('keeps today’s path for an intent off the list', async () => {
    const { store } = await drawnByServer()
    const offList: WindowLayoutCommand[] = [
      { type: 'renamePane', tabId: TAB_1, leafId: LEAF_ID, title: 'x' },
      { type: 'closeTabs', tabIds: [TAB_1] },
      { type: 'splitPane', tabId: TAB_1, leafId: LEAF_ID, direction: 'vertical' }
    ]
    for (const command of offList) {
      expect(SERVER_ROUTED_LAYOUT_COMMANDS).not.toContain(command.type)
      expect(send(store, command).taken).toBe(false)
    }
    await settle()
    expect(hoisted.sent).toEqual([])
  })

  it('keeps today’s path for a tab the server’s frames do not hold', async () => {
    const { store } = await drawnByServer()
    const command = { type: 'equalizePanes', tabId: 'web-terminal-unknown' } as const
    expect(send(store, command).taken).toBe(false)
    expect(hoisted.sent).toEqual([])
  })

  it.each([
    { reply: { ok: false, code: 'host_not_owned' } as const, code: 'host_not_owned' },
    { reply: { ok: false, code: 'tab_not_found' } as const, code: 'tab_not_found' },
    { reply: new Error('connection lost'), code: 'call_failed' }
  ])(
    'redraws from the server’s frames on $code, applies nothing here, and sends it once',
    async ({ reply, code }) => {
      const { store, stream, frames } = await drawnByServer()
      hoisted.reply = async () => {
        if (reply instanceof Error) {
          throw reply
        }
        return reply
      }
      // The window drew the move itself meanwhile; the server does not take it.
      const { taken, handlers } = send(store, {
        type: 'moveTab',
        tabId: TAB_2,
        toGroupId: HOST_GROUP,
        index: 0
      })
      store.setState({
        groupsByWorktree: {
          ...store.getState().groupsByWorktree,
          [WT]: (store.getState().groupsByWorktree[WT] ?? []).map((group) => ({
            ...group,
            tabOrder: [TAB_2, TAB_1]
          }))
        }
      })
      await settle()
      await settle()

      expect(taken).toBe(true)
      expect(handlers.refused).toHaveBeenCalledWith(code)
      expect(handlers.apply).not.toHaveBeenCalled()
      expect(handlers.asToday).not.toHaveBeenCalled()
      expect(orderOf(store)).toEqual([TAB_1, TAB_2])

      // A reconnect does not send it again: the server may have applied it.
      stream.onStatus({ state: 'lost' })
      stream.onStatus({ state: 'connecting' })
      streams.send(stream, senderSnapshot(frames, { [WT]: TWO_TABS }, 1))
      await settle()
      expect(hoisted.sent).toHaveLength(1)
    }
  )

  it('keeps today’s path once the server’s stream stops, and for a server without layout intents', async () => {
    const { store, stream } = await drawnByServer()
    stream.onStatus({ state: 'lost' })
    await settle()
    expect(send(store, { type: 'equalizePanes', tabId: TAB_1 }).taken).toBe(false)

    uninstallAll()
    const older = mirroredStore()
    install(older)
    setServers(older, [{ ...CAPABLE, capable: false }])
    expect(streams.of(ENV).filter((open) => !open.closed)).toHaveLength(0)
    expect(send(older, { type: 'equalizePanes', tabId: TAB_1 }).taken).toBe(false)
    expect(hoisted.sent).toEqual([])
  })

  it('lets a reply waiting on a server whose stream closes show at once', async () => {
    const { store } = await drawnByServer()
    hoisted.reply = async () => ({ ok: true, result: {}, frameSeq: 9 })
    const { handlers } = send(store, { type: 'equalizePanes', tabId: TAB_1 })
    await settle()
    expect(handlers.apply).not.toHaveBeenCalled()

    uninstallAll()
    await settle()
    expect(handlers.apply).toHaveBeenCalledTimes(1)
  })
})
