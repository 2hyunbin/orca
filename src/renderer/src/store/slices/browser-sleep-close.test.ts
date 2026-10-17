import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

const mockCallRuntimeRpc = vi.hoisted(() => vi.fn())

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

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return { ...actual, callRuntimeRpc: mockCallRuntimeRpc }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

function storeWithRemoteBrowserTab(): {
  store: ReturnType<typeof createTestStore>
  workspaceId: string
} {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    activeTabType: 'terminal'
  })
  const workspace = store.getState().createBrowserTab(WT, 'about:blank', {
    activate: true,
    browserPageId: 'remote-page-1',
    browserRuntimeEnvironmentId: 'env-1'
  })
  const pageId = store.getState().browserPagesByWorkspace[workspace.id]?.[0]?.id ?? ''
  store.getState().setRemoteBrowserPageHandle(pageId, {
    environmentId: 'env-1',
    remotePageId: 'remote-page-1',
    staged: true
  })
  return { store, workspaceId: workspace.id }
}

describe('browser tabs closed by workspace sleep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCallRuntimeRpc.mockResolvedValue({})
  })

  // Why: reopen-closed is the user's undo history; a slept tab was never closed by the user.
  it('does not enter the reopen stack', async () => {
    const { store } = storeWithRemoteBrowserTab()

    await store.getState().shutdownWorktreeBrowsers(WT, { reason: 'sleep' })

    const s = store.getState()
    expect(s.browserTabsByWorktree[WT] ?? []).toEqual([])
    expect(s.recentlyClosedBrowserTabsByWorktree[WT] ?? []).toEqual([])
    expect(s.recentlyClosedTabKindsByWorktree[WT] ?? []).toEqual([])
    expect(s.reopenClosedBrowserTab(WT)).toBeNull()
  })

  // Why: unlike an unwound create, a slept tab's host page exists and must still be released.
  it('still closes the host page', async () => {
    const { store } = storeWithRemoteBrowserTab()

    await store.getState().shutdownWorktreeBrowsers(WT, { reason: 'sleep' })

    expect(mockCallRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'browser.tabClose',
      expect.objectContaining({ page: 'remote-page-1' }),
      expect.anything()
    )
  })

  it('leaves the reopen stack for a user close', () => {
    const { store, workspaceId } = storeWithRemoteBrowserTab()

    store.getState().closeBrowserTab(workspaceId)

    expect(store.getState().recentlyClosedBrowserTabsByWorktree[WT]).toHaveLength(1)
  })
})
