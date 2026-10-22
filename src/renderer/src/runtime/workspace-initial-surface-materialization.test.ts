// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
import { applyStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { materializeWorkspaceInitialSurface } from './workspace-initial-surface-materialization'
import { resolveWebSessionVisibleTabId } from './web-session-focus-intent'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'
import { recordWebSessionCloseIntent } from './web-session-close-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

const WORKTREE = 'repo::new-worktree'
const OTHER = 'repo::other-worktree'
const AGENT = 'agent-terminal'
const ANCILLARY = 'setup-terminal'
const LEAF = '00000000-0000-4000-8000-000000000001'
const SETUP_LEAF = '00000000-0000-4000-8000-000000000002'
const SESSION = 'initial-chat'

function topology(mode: 'chat' | 'terminal'): RuntimeMobileSessionTabsResult {
  const agentId = mode === 'chat' ? `agent-session:${SESSION}` : `${AGENT}::${LEAF}`
  return {
    worktree: WORKTREE,
    publicationEpoch: 'initial-host-epoch',
    snapshotVersion: 2,
    activeTabId: agentId,
    activeTabType: mode === 'chat' ? 'agent-session' : 'terminal',
    activeGroupId: 'host-group',
    tabGroups: [{ id: 'host-group', activeTabId: agentId, tabOrder: [agentId, ANCILLARY] }],
    tabs: [
      mode === 'chat'
        ? {
            type: 'agent-session',
            id: agentId,
            title: 'Claude Chat',
            sessionId: SESSION,
            agent: 'claude',
            isActive: true
          }
        : {
            type: 'terminal',
            id: agentId,
            parentTabId: AGENT,
            leafId: LEAF,
            title: 'Claude',
            terminal: 'agent-pty',
            status: 'ready',
            isActive: true
          },
      {
        type: 'terminal',
        id: `${ANCILLARY}::${SETUP_LEAF}`,
        parentTabId: ANCILLARY,
        leafId: SETUP_LEAF,
        title: '',
        terminal: 'setup-pty',
        status: 'ready',
        isActive: false
      }
    ]
  }
}

function deliver(snapshot: RuntimeMobileSessionTabsResult): void {
  materializeWorkspaceInitialSurface({
    worktreeId: WORKTREE,
    initialWorkspaceTopology: snapshot,
    ptyId: 'setup-pty',
    tabId: ANCILLARY,
    leafId: SETUP_LEAF,
    activate: false,
    surfaceOwner: false
  })
}

beforeEach(() => {
  createStoreSessionMockApi()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: OTHER,
    activeTabId: 'other-tab',
    bumpWorktreeActivity: vi.fn(),
    setTabCustomTitle: vi.fn()
  })
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSyncTestState()
})

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSyncTestState()
})

describe('initial topology before ancillary terminal delivery', () => {
  it('adopts the native terminal from a result census without adding an empty ancillary tab', () => {
    const snapshot = topology('terminal')
    snapshot.tabs = snapshot.tabs.filter(
      (tab) => tab.type === 'terminal' && tab.parentTabId === AGENT
    )
    // The result refresh first consumes the chat projection at this same version.
    applyStructuredSessionTabSnapshots([snapshot])
    materializeWorkspaceInitialSurface(
      { worktreeId: WORKTREE, initialWorkspaceTopology: snapshot },
      { appendAncillary: false }
    )
    const state = useAppStore.getState()
    expect(state.tabsByWorktree[WORKTREE]!.map((tab) => tab.id)).toEqual([AGENT])
    expect(state.terminalLayoutsByTabId[AGENT]!.ptyIdsByLeafId).toEqual({ [LEAF]: 'agent-pty' })
    expect(resolveWebSessionVisibleTabId(state, WORKTREE)).toBe(AGENT)
    expect(state.activeWorktreeId).toBe(OTHER)
  })

  it.each(['chat', 'terminal'] as const)('fills an empty visible workspace with its %s', (mode) => {
    useAppStore.setState({ activeWorktreeId: WORKTREE, activeTabId: null })
    deliver(topology(mode))
    const state = useAppStore.getState()
    expect(state.activeTabId).toBe(resolveWebSessionVisibleTabId(state, WORKTREE))
    expect(state.activeTabId).not.toBe(ANCILLARY)
    expect(state.activeTabType).toBe(mode === 'chat' ? 'agent-session' : 'terminal')
  })

  it.each(['chat', 'terminal'] as const)(
    'initializes the %s before ancillary selection and keeps later choices through replay',
    (mode) => {
      const committed: (string | null)[] = []
      const stop = useAppStore.subscribe((state) => {
        committed.push(resolveWebSessionVisibleTabId(state, WORKTREE))
      })
      const snapshot = topology(mode)
      deliver(snapshot)
      stop()
      const initialized = useAppStore.getState()
      const agent = initialized.unifiedTabsByWorktree[WORKTREE]!.find((tab) =>
        mode === 'chat' ? tab.entityId === SESSION : tab.entityId === AGENT
      )!
      expect(committed.length).toBeGreaterThan(0)
      expect(committed.every((tabId) => tabId === agent.id)).toBe(true)
      expect(initialized.activeWorktreeId).toBe(OTHER)
      expect(initialized.activeTabId).toBe('other-tab')
      expect(initialized.activeTabIdByWorktree[WORKTREE]).toBe(agent.id)
      const published = buildMobileSessionTabSnapshots(initialized, false).find(
        (workspace) => workspace.worktree === WORKTREE
      )!
      if (mode === 'terminal') {
        expect(published.activeTabType).toBe('terminal')
        expect(published.activeTabId).toBe(snapshot.activeTabId)
      } else {
        // Chat rows are host-owned; the renderer publishes their group placement.
        expect(published.tabs.some((tab) => tab.isActive)).toBe(false)
        expect(
          published.tabGroups?.find((group) => group.id === published.activeGroupId)?.activeTabId
        ).toBe(snapshot.activeTabId)
      }
      expect(
        initialized.tabsByWorktree[WORKTREE]!.filter((tab) => tab.id === ANCILLARY)
      ).toHaveLength(1)
      if (mode === 'terminal') {
        expect(initialized.tabsByWorktree[WORKTREE]!.map((tab) => tab.id)).toEqual([
          AGENT,
          ANCILLARY
        ])
        expect(initialized.terminalLayoutsByTabId[AGENT]!.ptyIdsByLeafId).toEqual({
          [LEAF]: 'agent-pty'
        })
      }
      // The standalone inventory arrives after ancillary IPC, then a real Setup pick wins.
      applyStructuredSessionTabSnapshots([snapshot])
      const setup = useAppStore
        .getState()
        .unifiedTabsByWorktree[WORKTREE]!.find((tab) => tab.entityId === ANCILLARY)!
      useAppStore.getState().activateTab(setup.id, { worktreeId: WORKTREE, recordFocus: false })
      useAppStore.getState().activateTab(setup.id, { worktreeId: WORKTREE, recordFocus: false })
      deliver({ ...snapshot, snapshotVersion: 3 })
      deliver(snapshot)
      const picked = useAppStore.getState()
      expect(resolveWebSessionVisibleTabId(picked, WORKTREE)).toBe(setup.id)
      useAppStore.setState({ activeWorktreeId: WORKTREE })
      expect(resolveWebSessionVisibleTabId(useAppStore.getState(), WORKTREE)).toBe(setup.id)
    }
  )

  it.each(['chat', 'terminal'] as const)(
    'keeps a closed %s fenced from delayed topology',
    (mode) => {
      recordWebSessionCloseIntent(
        { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
        WORKTREE,
        `agent-session:${SESSION}`,
        Date.now()
      )
      useAppStore.setState({
        closedTerminalTabTombstonesByTabId: {
          [AGENT]: { closedAt: Date.now(), worktreeId: WORKTREE, reason: 'user' }
        }
      })
      deliver(topology(mode))
      expect(useAppStore.getState().tabsByWorktree[WORKTREE]!.map((tab) => tab.id)).toEqual([
        ANCILLARY
      ])
      expect(useAppStore.getState().ptyIdsByTabId[AGENT]).toBeUndefined()
      expect(
        useAppStore
          .getState()
          .unifiedTabsByWorktree[WORKTREE]!.some((tab) => tab.entityId === SESSION)
      ).toBe(false)
    }
  )
})
