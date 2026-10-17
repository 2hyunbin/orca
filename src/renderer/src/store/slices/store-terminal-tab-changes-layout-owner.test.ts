import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeWorktree,
  runtimeOwnedRepoState,
  seedStore
} from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

type Reply = { ok: boolean; result?: object; code?: string }

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  callRuntimeRpc: vi.fn(async (..._args: unknown[]): Promise<Reply> => ({ ok: true, result: {} }))
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
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

const WORKTREE = 'repo1::/path/wt'
const LEAF = '11111111-1111-4111-8111-111111111111'

function storeWithTab(options: { launchAgent?: 'claude' } = {}) {
  const store = createTestStore()
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })] }
  })
  const tab = store.getState().createTab(WORKTREE, undefined, undefined, {
    initialLeafId: LEAF,
    ...options
  })
  const tabBarId = store.getState().unifiedTabsByWorktree[WORKTREE]![0]!.id
  mocks.callRuntimeRpc.mockClear()
  return { store, tabId: tab.id, tabBarId }
}

/** The layout commands sent after the tab's create. */
const sent = () => mocks.callRuntimeRpc.mock.calls.map((call) => call[2])

const row = (store: ReturnType<typeof createTestStore>) =>
  store.getState().tabsByWorktree[WORKTREE]![0]!

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockReset()
  mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a terminal tab’s own changes in a layout-owner build', () => {
  it('renames in main first by tab-bar id, then the window shows the title', async () => {
    const { store, tabId, tabBarId } = storeWithTab()

    store.getState().setTabCustomTitle(tabId, 'Build')

    expect(sent()).toEqual([
      {
        command: {
          type: 'renameTab',
          workspace: WORKTREE,
          tabId: tabBarId,
          kind: 'custom',
          title: 'Build'
        }
      }
    ])
    expect(row(store).customTitle).toBeFalsy()
    await vi.waitFor(() => expect(row(store).customTitle).toBe('Build'))
  })

  it('leaves the window’s color as it is when main refuses', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'invalid_params' })
    const { store, tabId, tabBarId } = storeWithTab()

    store.getState().setTabColor(tabId, '#f00')

    expect(sent()).toEqual([
      { command: { type: 'setTabProps', workspace: WORKTREE, tabId: tabBarId, color: '#f00' } }
    ])
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
    expect(row(store).color).toBeFalsy()
  })

  it('sends an agent’s generated title as main’s rename', async () => {
    const { store, tabId, tabBarId } = storeWithTab()

    store
      .getState()
      .setGeneratedTabTitleFromAgentPrompt(makePaneKey(tabId, LEAF), 'Refactor the auth middleware')

    expect(sent()).toEqual([
      {
        command: expect.objectContaining({
          type: 'renameTab',
          tabId: tabBarId,
          kind: 'generated',
          title: expect.any(String)
        })
      }
    ])
    await vi.waitFor(() => expect(row(store).generatedTitle).toBeTruthy())
  })

  it('forgets an ended launch agent in main, and sends nothing for a tab without one', async () => {
    const launched = storeWithTab({ launchAgent: 'claude' })
    launched.store.getState().clearTabLaunchAgent(launched.tabId)

    expect(sent()).toEqual([
      {
        command: {
          type: 'setTabProps',
          workspace: WORKTREE,
          tabId: launched.tabBarId,
          clearLaunchAgent: true
        }
      }
    ])
    await vi.waitFor(() => expect(row(launched.store).launchAgent).toBeUndefined())

    const plain = storeWithTab()
    plain.store.getState().clearTabLaunchAgent(plain.tabId)
    plain.store.getState().setAiVaultTabTitle(plain.tabId, null)
    expect(sent()).toEqual([])
  })

  it('switches the view in main first, and a toggle names the mode it switches to', async () => {
    const { store, tabBarId } = storeWithTab()

    store.getState().toggleTabViewMode(tabBarId)

    expect(sent()).toEqual([
      { command: { type: 'setTabProps', workspace: WORKTREE, tabId: tabBarId, viewMode: 'chat' } }
    ])
    expect(row(store).viewMode).toBeUndefined()
    await vi.waitFor(() => expect(row(store).viewMode).toBe('chat'))
  })

  it('acts as today at once for a paired server’s workspace', () => {
    const store = createTestStore()
    const worktree = makeRuntimeOwnedWorktree({ id: WORKTREE, repoId: 'repo1' }, 'env-1')
    seedStore(
      store,
      runtimeOwnedRepoState('env-1', 'repo1', '/path', { worktreesByRepo: { repo1: [worktree] } })
    )
    const tab = store.getState().createTab(WORKTREE)

    store.getState().setTabCustomTitle(tab.id, 'Build')

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(row(store).customTitle).toBe('Build')
  })

  it('acts as today with the switch off', () => {
    mocks.layoutOwnerIsMain = false
    const { store, tabId } = storeWithTab()

    store.getState().setTabCustomTitle(tabId, 'Build')

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(row(store).customTitle).toBe('Build')
  })
})
