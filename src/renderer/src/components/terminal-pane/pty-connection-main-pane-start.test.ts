// Layout-owner build: a pane main is starting a terminal for never starts one of its own. It waits,
// then attaches to main's terminal; a start that failed shows why.
import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  leafIdForPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const TAB = 'tab-main-start'
const PANE_KEY = `${TAB}:${leafIdForPane(1)}`

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

function setStore(patch: Partial<StoreState>): void {
  mockStoreState = { ...mockStoreState, ...patch }
  for (const listener of storeSubscribers) {
    listener(mockStoreState)
  }
}

async function connectWithStart(start: unknown) {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport()
  transportFactoryQueue.push(transport)
  setStore({
    tabsByWorktree: { 'wt-1': [{ id: TAB, ptyId: null }] },
    terminalPaneStartsByPaneKey: { [PANE_KEY]: start }
  } as never)
  const deps = buildPaneConnectionDeps(() => mockStoreState, { tabId: TAB })
  connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
  await flushAsyncTicks()
  return { transport, deps }
}

describe('a pane main is starting a terminal for', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    bindPtyConnectionTestMocks({
      getState: () => mockStoreState,
      getTransportQueue: () => transportFactoryQueue,
      getTransportOptions: () => [],
      getStoreSubscribers: () => storeSubscribers,
      setStoreSubscribers: (subscribers) => {
        storeSubscribers = subscribers
      }
    })
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('starts nothing while main starts it, then connects once main’s start ends', async () => {
    const { transport } = await connectWithStart({ status: 'starting' })
    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).not.toHaveBeenCalled()

    setStore({ terminalPaneStartsByPaneKey: {} } as never)
    await flushAsyncTicks()

    expect(transport.connect.mock.calls.length + transport.attach.mock.calls.length).toBe(1)
  })

  it('shows why a failed start failed and starts nothing', async () => {
    const { transport, deps } = await connectWithStart({
      status: 'failed',
      reason: 'agent runtime needs repair'
    })

    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
      1,
      'The terminal could not start: agent runtime needs repair'
    )
  })

  it('starts a pane with no start from main as before', async () => {
    const { transport } = await connectWithStart(undefined)

    expect(transport.connect.mock.calls.length + transport.attach.mock.calls.length).toBe(1)
  })
})
