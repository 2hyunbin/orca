import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as FrameDrawnModule from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { _resetLayoutFramePositionForTests } from './layout-frame-position'
import {
  CAPABLE,
  ENV,
  HOST_GROUP,
  WT,
  SERVER_LAYOUT,
  createFakeLayoutStreams,
  createServerHarness,
  settle,
  type TestStore
} from './server-layout-frames.test-fixture'
import {
  isFrameDrawnServerWorkspace,
  resetFrameDrawnServerWorkspacesForTests
} from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { resetMirroredTerminalHandlesForTests } from './web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

type Subscribe = (...args: never[]) => { close: () => void }
const hoisted = vi.hoisted(
  (): {
    owners: Map<string, string>
    resync: Mock<(environmentId: string, worktreeId: string) => Promise<void>>
    call: Mock<(target: unknown, method: string, params?: unknown) => Promise<unknown>>
    subscribe: Subscribe | null
  } => ({
    owners: new Map(),
    resync: vi.fn(),
    call: vi.fn(),
    subscribe: null
  })
)

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (...args: never[]) => hoisted.subscribe!(...args)
}))
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (target: unknown, method: string, params?: unknown) =>
    hoisted.call(target, method, params)
}))
vi.mock('./web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (_state: unknown, key: string) =>
    hoisted.owners.get(key) ?? null
}))
vi.mock('./web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))

createStoreSessionMockApi()

const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe

/** A workspace this window holds that no server's frames draw. */
const LOCAL_WT = 'repo::/local-worktree'
const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

beforeEach(() => {
  hoisted.owners.clear()
  hoisted.resync.mockReset().mockResolvedValue(undefined)
  hoisted.call.mockReset().mockResolvedValue({ ok: true })
  streams.all.length = 0
  resetWebSessionTabsSyncTestState()
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
})
afterEach(uninstallAll)

function reports(): unknown[] {
  return hoisted.call.mock.calls
    .filter(([, method]) => method === 'layout.reportView')
    .map(([target, , params]) => ({ target, params }))
}

function showGroup(store: TestStore, key: string, groupId: string): void {
  store.setState({
    activeGroupIdByWorktree: { ...store.getState().activeGroupIdByWorktree, [key]: groupId }
  })
}

async function frameDrawnStore(): Promise<TestStore> {
  const store = mirroredStore()
  showGroup(store, LOCAL_WT, 'local-group')
  install(store)
  setServers(store, [CAPABLE])
  streams.send(streams.openTo(ENV), {
    type: 'snapshot',
    workspaces: [{ key: WT, layout: SERVER_LAYOUT }],
    seq: 1,
    epoch: 'e'
  })
  await settle()
  return store
}

describe('the group this window shows, told to the server whose frames draw it', () => {
  it('reports the frame-drawn workspaces only', async () => {
    await frameDrawnStore()

    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    expect(reports()).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { activeGroupByWorkspace: { [WT]: HOST_GROUP }, refresh: true }
      }
    ])
  })

  it('sends again only when a group changes', async () => {
    const store = await frameDrawnStore()
    hoisted.call.mockClear()

    showGroup(store, LOCAL_WT, 'local-group-2')
    store.setState({ activeGroupIdByWorktree: { ...store.getState().activeGroupIdByWorktree } })
    expect(reports()).toEqual([])

    showGroup(store, WT, 'host-group-2')
    showGroup(store, WT, 'host-group-2')
    expect(reports()).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { activeGroupByWorkspace: { [WT]: 'host-group-2' } }
      }
    ])
  })

  it('does not resend a report the server failed to take', async () => {
    hoisted.call.mockRejectedValue(new Error('offline'))
    const store = await frameDrawnStore()
    store.setState({ activeGroupIdByWorktree: { ...store.getState().activeGroupIdByWorktree } })
    await settle()

    expect(reports()).toHaveLength(1)
  })

  it("reports again on a new stream's snapshot as a refresh, then a change as live", async () => {
    const store = await frameDrawnStore()
    hoisted.call.mockClear()

    streams.send(streams.openTo(ENV), {
      type: 'snapshot',
      workspaces: [{ key: WT, layout: SERVER_LAYOUT }],
      seq: 2,
      epoch: 'e2'
    })
    await settle()

    expect(reports()).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { activeGroupByWorkspace: { [WT]: HOST_GROUP }, refresh: true }
      }
    ])

    hoisted.call.mockClear()
    showGroup(store, WT, 'host-group-2')
    expect(reports()).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { activeGroupByWorkspace: { [WT]: 'host-group-2' } }
      }
    ])
  })

  it('sends nothing to a server without layout intents', async () => {
    const store = mirroredStore()
    install(store)
    setServers(store, [{ ...CAPABLE, capable: false }])
    showGroup(store, WT, 'host-group-2')
    await settle()

    // Presence: the server is paired and its workspace mirrored, with a group shown.
    expect(store.getState().runtimeEnvironments.map((environment) => environment.id)).toEqual([ENV])
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe('host-group-2')
    expect(reports()).toEqual([])
  })
})
