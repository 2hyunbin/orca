import { vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type * as PtyConnection from './pty-connection'
import type { AgentStatusPatch } from '@/store/agent-status-patch'
import { LEAF_1 } from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'

export async function createInitialStoreState() {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const store = createTestStore()
  const { getAgentStatusOwner } = await import('@/store/agent-status-commit')
  const { applyAgentStatusPatch } = await import('@/store/agent-status-patch')
  const { makeTab, makeWorktree, TEST_REPO } = await import('@/store/slices/store-test-helpers')
  store.setState({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'tab-pty' })] },
    ptyIdsByTabId: { 'tab-1': ['tab-pty'] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_1 },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'tab-pty' }
      }
    },
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', displayName: 'feat/notis' })
      ]
    },
    repos: [
      {
        ...TEST_REPO,
        id: 'repo1',
        connectionId: null,
        executionHostId: 'local',
        displayName: 'orca'
      }
    ],
    settings: {
      ...getDefaultSettings('/tmp'),
      promptCacheTimerEnabled: true,
      experimentalTerminalAttention: true,
      terminalMainSideEffectAuthority: false
    }
  })
  const state = store.getState()
  const spies = {
    removeDeferredSshReconnectTarget: vi.spyOn(state, 'removeDeferredSshReconnectTarget'),
    removeDeferredSshSessionId: vi.spyOn(state, 'removeDeferredSshSessionId'),
    consumePendingColdRestore: vi.spyOn(state, 'consumePendingColdRestore'),
    consumePendingSnapshot: vi.spyOn(state, 'consumePendingSnapshot'),
    getAgentLaunchConfigForStatusEntry: vi.spyOn(state, 'getAgentLaunchConfigForStatusEntry'),
    clearSleepingAgentSession: vi.spyOn(state, 'clearSleepingAgentSession'),
    registerAgentLaunchConfig: vi.spyOn(state, 'registerAgentLaunchConfig'),
    clearAgentLaunchConfig: vi.spyOn(state, 'clearAgentLaunchConfig'),
    observeTerminalGitHubPullRequestLink: vi.spyOn(state, 'observeTerminalGitHubPullRequestLink'),
    recordTerminalInput: vi.spyOn(state, 'recordTerminalInput'),
    setAgentStatus: vi.spyOn(state, 'setAgentStatus'),
    removeAgentStatus: vi.spyOn(state, 'removeAgentStatus'),
    dropAgentStatus: vi.spyOn(state, 'dropAgentStatus'),
    retireAgentPaneAuthority: vi.spyOn(state, 'retireAgentPaneAuthority'),
    restoreAgentPaneAuthority: vi.spyOn(state, 'restoreAgentPaneAuthority'),
    setPaneForegroundAgent: vi.spyOn(state, 'setPaneForegroundAgent'),
    clearPaneForegroundAgent: vi.spyOn(state, 'clearPaneForegroundAgent'),
    markTerminalBell: vi.spyOn(state, 'markTerminalBell'),
    markAgentAttentionUnread: vi.spyOn(state, 'markAgentAttentionUnread')
  }
  const bindings = new Set<{ dispose: () => void }>()
  const owner = getAgentStatusOwner(store)
  return {
    store,
    own(module: typeof PtyConnection) {
      return {
        ...module,
        connectPanePty: (...args: Parameters<typeof module.connectPanePty>) => {
          const binding = module.connectPanePty(...args)
          bindings.add(binding)
          return binding
        }
      }
    },
    dispose: () => {
      for (const binding of bindings) {
        binding.dispose()
      }
      bindings.clear()
    },
    actions: spies,
    read: owner.getState,
    patch: (patch: AgentStatusPatch) => applyAgentStatusPatch(store, patch),
    setStatus: (key: string, entry: AgentStatusEntry | undefined) =>
      owner.transact((transaction) => transaction.setEntry(key, entry))
  }
}

export function buildReattachPaneTitleState(current: StoreState, title: string): StoreState {
  return {
    ...current,
    tabsByWorktree: {
      'wt-1': current.tabsByWorktree['wt-1'].map((tab) => ({ ...tab, title }))
    },
    runtimePaneTitlesByTabId: {
      'tab-1': { 1: title }
    }
  }
}

// Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
export function buildActiveRuntimeEnvironmentState(
  current: StoreState,
  environmentId: string
): StoreState {
  return {
    ...current,
    // The client stamps a server's rows on arrival; focus alone never names the owner.
    repos: current.repos.map((repo) => ({
      ...repo,
      executionHostId: `runtime:${environmentId}`
    })),
    settings: {
      ...getDefaultSettings('/tmp'),
      ...current.settings,
      activeRuntimeEnvironmentId: environmentId
    }
  }
}
