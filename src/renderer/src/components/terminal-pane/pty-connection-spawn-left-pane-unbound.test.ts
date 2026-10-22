import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep,
  requestTerminalPaneRecovery
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  requestTerminalPaneRecovery: vi.fn(async () => true)
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

// Only the request is spied: connect still needs the real generation/instance registry.
vi.mock('./terminal-pane-recovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestTerminalPaneRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

describe('fresh spawn leaves a local pane unbound', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  it.each([false, true])(
    'mounts and remounts the tab owner while an unrelated workspace is active (%s)',
    async (reverse) => {
      const { connectPanePty } = await import('./pty-connection')
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const local = { id: 'wt-1', repoId: 'repo1', path: '/local', hostId: 'local' }
      const remote = { ...local, path: '/remote', hostId: 'runtime:server' }
      mockStoreState.activeWorktreeId = 'unrelated'
      mockStoreState.worktreesByRepo = reverse
        ? { first: [remote], second: [local] }
        : { first: [local], second: [remote] }
      mockStoreState.repos = reverse
        ? [
            { id: 'repo1', executionHostId: 'runtime:server' },
            { id: 'repo1', executionHostId: 'local' }
          ]
        : [
            { id: 'repo1', executionHostId: 'local' },
            { id: 'repo1', executionHostId: 'runtime:server' }
          ]
      Object.assign(mockStoreState, {
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'unified-1',
              entityId: 'tab-1',
              contentType: 'terminal',
              executionHostId: 'runtime:server'
            }
          ]
        },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lookup reads the supplied worktree/repo/host catalogs.
        getKnownWorktreeById: (id: string, host?: ExecutionHostId) =>
          findKnownWorktreeById(mockStoreState as never, id, host)
      })
      for (let mount = 0; mount < 2; mount++) {
        const pane = createPane(1)
        const transport = createMockTransport('remote:server@@pty-1')
        transportFactoryQueue.push(transport)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies connector pane/manager/dependency members.
        const binding = connectPanePty(
          pane as never,
          createManager(1) as never,
          createDeps() as never
        )
        await flushAsyncTicks(40)
        expect(createRemoteRuntimePtyTransport).toHaveBeenLastCalledWith(
          'server',
          expect.any(Object)
        )
        expect(transport.connect).toHaveBeenCalled()
        const input = pane.terminal.onData.mock.calls.at(-1)?.[0]
        input('continue\r')
        expect(transport.sendInput).toHaveBeenCalledWith('continue\r', expect.anything())
        expect(mockStoreState.activeWorktreeId).toBe('unrelated')
        binding.dispose()
      }
    }
  )

  it.each(['local', 'runtime:server'] as const)(
    'continues a recorded live folder owner despite ambiguous inventory (%s)',
    async (host) => {
      const { connectPanePty } = await import('./pty-connection')
      const worktreeId = 'folder:ambiguous'
      Object.assign(mockStoreState, {
        folderWorkspaces: [{ id: 'ambiguous', projectGroupId: 'mixed', folderPath: '/work' }],
        projectGroups: [{ id: 'mixed', parentPath: '/work' }],
        repos: [
          { id: 'local', path: '/work/local', projectGroupId: 'mixed' },
          { id: 'ssh', path: '/work/ssh', projectGroupId: 'mixed', executionHostId: 'ssh:prod' }
        ],
        unifiedTabsByWorktree: {
          [worktreeId]: [
            { id: 'u', entityId: 'tab-1', contentType: 'terminal', executionHostId: host }
          ]
        },
        tabsByWorktree: {
          [worktreeId]: [
            { id: 'tab-1', ptyId: host === 'local' ? 'pty-local' : 'remote:server@@pty-live' }
          ]
        }
      })
      for (let mount = 0; mount < 2; mount++) {
        const transport = createMockTransport(
          host === 'local' ? 'pty-local' : 'remote:server@@pty-live'
        )
        transportFactoryQueue.push(transport)
        const pane = createPane(1)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the connector members exercised by attachment and input.
        const binding = connectPanePty(
          pane as never,
          createManager(1) as never,
          createDeps({ worktreeId }) as never
        )
        await flushAsyncTicks(40)
        if (host === 'local') {
          expect(transport.connect).toHaveBeenCalled()
        } else {
          expect(transport.attach).toHaveBeenCalled()
        }
        pane.terminal.onData.mock.calls.at(-1)?.[0]('continue\r')
        expect(transport.sendInput).toHaveBeenCalledWith('continue\r', expect.anything())
        expect(createdTransportOptions.at(-1)?.env).not.toHaveProperty('ORCA_WORKSPACE_ROOT')
        binding.dispose()
      }
    }
  )

  it('remounts the pane when the spawn resolves without a PTY id', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    // A spawn that produced nothing: no id returned and nothing bound after it.
    transport.connect.mockImplementation(async () => null)
    transportFactoryQueue.push(transport)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ tabId: 'tab-unbound-spawn' }) as never
    )
    await flushAsyncTicks(40)

    expect(transport.connect).toHaveBeenCalled()
    expect(requestTerminalPaneRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-unbound-spawn',
        ptyId: null,
        reason: 'spawn-left-pane-unbound'
      })
    )
  })

  // #21195: connect() resolves empty while the remote transport still holds an armed retry.
  it('leaves recovery to a transport that owns its own retry', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = Object.assign(createMockTransport(), { ownsRecovery: vi.fn(() => true) })
    transport.connect.mockImplementation(async () => undefined)
    transportFactoryQueue.push(transport)

    const deps = createDeps({ tabId: 'tab-transport-retry' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocks cover every pane, manager, and deps member the connect path reads.
    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(40)

    expect(transport.connect).toHaveBeenCalled()
    expect(transport.ownsRecovery).toHaveBeenCalled()
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'spawn-left-pane-unbound' })
    )
  })

  it('does not remount when the spawn bound a PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-bound')
    transportFactoryQueue.push(transport)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ tabId: 'tab-bound-spawn' }) as never
    )
    await flushAsyncTicks(40)

    expect(requestTerminalPaneRecovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'spawn-left-pane-unbound' })
    )
  })

  // The other half of the observation gate for this reason. A remount for
  // 'spawn-left-pane-unbound' heals by spawning, not by reattaching, so it
  // reaches none of the reattach settle points. Binding a PTY IS the outcome,
  // and reporting it is what keeps the attempt from sitting 'pending' for the
  // whole settlement bound and blocking the tab's next recovery.
  it('settles the tab recovery attempt as a success when the spawn binds a PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const settleTerminalTabRecovery = vi.fn()
    mockStoreState = { ...mockStoreState, settleTerminalTabRecovery } as StoreState
    const transport = createMockTransport('pty-bound')
    transportFactoryQueue.push(transport)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ tabId: 'tab-bound-spawn' }) as never
    )
    await flushAsyncTicks(40)

    expect(settleTerminalTabRecovery).toHaveBeenCalledWith('tab-bound-spawn', 0, 'success')
  })

  // The failure half, which already had a settle point: the same call reports
  // 'failed' before it asks for the remount, so a spawn that keeps failing is
  // refused as a settled failure rather than retried on the cooldown.
  it('settles the attempt as failed before asking for the remount', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const settleTerminalTabRecovery = vi.fn()
    mockStoreState = { ...mockStoreState, settleTerminalTabRecovery } as StoreState
    const transport = createMockTransport()
    transport.connect.mockImplementation(async () => null)
    transportFactoryQueue.push(transport)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ tabId: 'tab-unbound-spawn' }) as never
    )
    await flushAsyncTicks(40)

    expect(settleTerminalTabRecovery).toHaveBeenCalledWith('tab-unbound-spawn', 0, 'failed')
    expect(settleTerminalTabRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      requestTerminalPaneRecovery.mock.invocationCallOrder[0]
    )
  })
})
