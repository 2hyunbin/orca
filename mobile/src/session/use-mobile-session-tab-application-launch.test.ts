import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import { launchedSelection, type PendingSessionSelection } from './pending-session-selection'
import { useMobileSessionTabApplication } from './use-mobile-session-tab-application'

function terminalTab(id: string, terminal: string, isActive = false): MobileSessionTab {
  return { type: 'terminal', id, parentTabId: id, leafId: 'leaf', title: 'T', terminal, isActive }
}

const PANE = {
  tabId: 'b1d3c0de-0000-4000-8000-000000000001',
  leafId: 'b1d3c0de-0000-4000-8000-000000000002'
}

function reservedTerminalTab(terminal: string, isActive = false): MobileSessionTab {
  return {
    type: 'terminal',
    id: `${PANE.tabId}::${PANE.leafId}`,
    parentTabId: PANE.tabId,
    leafId: PANE.leafId,
    title: 'Claude',
    terminal,
    isActive
  }
}

function chatTab(id: string, sessionId: string): MobileSessionTab {
  return { type: 'agent-session', id, title: 'Claude', sessionId, agent: 'claude', isActive: false }
}

let version = 0
function snapshot(tabs: MobileSessionTab[], extra: Partial<SessionTabsResult> = {}) {
  version += 1
  const active = tabs.find((tab) => tab.isActive) ?? null
  return {
    worktree: 'workspace-1',
    publicationEpoch: 'host-epoch:client-navigation',
    snapshotVersion: version,
    tabs,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    ...extra
  }
}

function mutableRef<T>(current: T): { current: T } {
  return { current }
}

function scope(pending: PendingSessionSelection | null) {
  const sendRequest = vi.fn(async () => ({
    id: 'x',
    ok: true as const,
    result: {},
    _meta: { runtimeId: 'r' }
  }))
  const client: Pick<RpcClient, 'sendRequest'> = { sendRequest }
  return {
    sendRequest,
    state: {
      hostId: 'host-1',
      worktreeId: 'workspace-1',
      client,
      setTerminals: vi.fn(),
      terminalsRef: { current: [] },
      setSessionTabs: vi.fn(),
      sessionTabsRef: { current: [] },
      appliedSnapshotMarkerRef: { current: { epoch: null, version: -1 } },
      appliedSessionTabsRevisionRef: { current: 0 },
      closedTabTombstonesRef: { current: new Map() },
      reconcileBufferedDraftsRef: { current: vi.fn() },
      setTerminalsLoaded: vi.fn(),
      defaultTerminalHandlesToLiveInput: vi.fn(),
      setActiveHandle: vi.fn(),
      setActiveSessionTabId: vi.fn(),
      activeSessionTabIdRef: mutableRef<string | null>('tab-old'),
      selectedSessionTabIdRef: mutableRef<string | null>('tab-old'),
      markdownDocsRef: { current: new Map() },
      initializedHandlesRef: { current: new Set<string>() },
      terminalDiagnosticsRef: { current: { tabsApplied: vi.fn() } },
      activeHandleRef: mutableRef<string | null>('term_old'),
      activeSessionTabTypeRef: { current: 'terminal' },
      pendingSelectionRef: { current: pending },
      pendingBrowserFocusPageIdRef: { current: null },
      initialSessionAutoCreateRef: { current: { sawSessionTabs: true } },
      unsubscribeTerminal: vi.fn(),
      subscribeToTerminal: vi.fn(),
      lastKnownTerminalCountRef: { current: 0 },
      clientRef: { current: client },
      creatingTerminalRef: mutableRef<string | null>('l1'),
      setCreating: vi.fn()
    }
  }
}

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

function mount(state: ReturnType<typeof scope>['state']) {
  let model: ReturnType<typeof useMobileSessionTabApplication> | undefined
  function Harness() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member applySessionTabs reads; a missing one throws on use.
    model = useMobileSessionTabApplication(state as never)
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
  return (result: SessionTabsResult) => model!.applySessionTabs(result)
}

function activations(sendRequest: ReturnType<typeof scope>['sendRequest']): unknown[] {
  return sendRequest.mock.calls.flatMap((call: unknown[]) =>
    call[0] === 'session.tabs.activate' ? [call[1]] : []
  )
}

describe('landing on a launched tab', () => {
  it('records a launched terminal as this device’s pick on the host once its tab arrives', () => {
    const { state, sendRequest } = scope(launchedSelection('l1', { handle: 'term_new' }))
    const apply = mount(state)
    const old = terminalTab('tab-old', 'term_old', true)

    apply(snapshot([old]))
    expect(activations(sendRequest)).toEqual([])

    apply(snapshot([old, terminalTab('tab-new', 'term_new')]))
    expect(activations(sendRequest)).toEqual([
      {
        worktree: 'id:workspace-1',
        tabId: 'tab-new',
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      }
    ])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('tab-new')
    expect(state.unsubscribeTerminal).toHaveBeenCalledWith('term_old')
    expect(state.subscribeToTerminal).toHaveBeenLastCalledWith('term_new')

    // Landed once: a later snapshot that still shows the old tab active does not re-send.
    apply(snapshot([old, terminalTab('tab-new', 'term_new')]))
    expect(activations(sendRequest)).toHaveLength(1)
  })

  it('records a launched chat, found by its session, by the tab id the host gave it', () => {
    const { state, sendRequest } = scope(launchedSelection('l1', { sessionId: 'claude_s1' }))
    const apply = mount(state)

    apply(snapshot([terminalTab('tab-old', 'term_old', true), chatTab('opaque-7', 'claude_s1')]))

    expect(activations(sendRequest)).toEqual([expect.objectContaining({ tabId: 'opaque-7' })])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('opaque-7')
  })

  it('leaves the host’s choice alone when it moved this device itself', () => {
    const { state, sendRequest } = scope(launchedSelection('l1', { handle: 'term_new' }))
    const apply = mount(state)

    apply(
      snapshot([terminalTab('tab-old', 'term_old', true), terminalTab('tab-new', 'term_new')], {
        navigationIntent: 'follow'
      })
    )

    expect(activations(sendRequest)).toEqual([])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('tab-old')
  })

  it('frees the + lock when the tab lands, not when the host replies', () => {
    const { state } = scope(launchedSelection('l1', { pane: PANE }, null))
    const apply = mount(state)
    const old = terminalTab('tab-old', 'term_old', true)

    apply(snapshot([old]))
    expect(state.creatingTerminalRef.current).toBe('l1')
    expect(state.setCreating).not.toHaveBeenCalled()

    apply(snapshot([old, reservedTerminalTab('term_new')]))
    expect(state.creatingTerminalRef.current).toBeNull()
    expect(state.setCreating).toHaveBeenCalledWith(false)
  })

  it("leaves a newer launch's lock alone", () => {
    const { state } = scope(launchedSelection('l1', { pane: PANE }, null))
    state.creatingTerminalRef.current = 'l2'
    const apply = mount(state)

    apply(snapshot([terminalTab('tab-old', 'term_old', true), reservedTerminalTab('term_new')]))

    expect(state.creatingTerminalRef.current).toBe('l2')
    expect(state.setCreating).not.toHaveBeenCalled()
  })

  it('lands in an empty session whose only tab the host selected before replying', () => {
    const { state, sendRequest } = scope(launchedSelection('l1', { pane: PANE }, null))
    state.activeSessionTabIdRef.current = null
    state.selectedSessionTabIdRef.current = null
    state.activeHandleRef.current = null
    const apply = mount(state)

    apply(snapshot([reservedTerminalTab('term_new', true)]))

    expect(activations(sendRequest)).toEqual([
      expect.objectContaining({ tabId: `${PANE.tabId}::${PANE.leafId}` })
    ])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith(`${PANE.tabId}::${PANE.leafId}`)
    expect(state.subscribeToTerminal).toHaveBeenLastCalledWith('term_new')
    expect(state.creatingTerminalRef.current).toBeNull()
  })
})

describe('a workspace that opens before its agent tab exists', () => {
  const setup = (isActive: boolean) => terminalTab('setup', 'term_setup', isActive)
  const chat = (isActive: boolean) => ({ ...chatTab('chat', 'sess-1'), isActive })

  // The bug: the phone kept the interim Setup it had shown once the host resolved the agent chat.
  it('follows the host from an interim Setup to the agent, unless this device tapped Setup', async () => {
    const { state, sendRequest } = scope(null)
    sendRequest.mockResolvedValue({
      id: 'x',
      ok: true,
      result: { worktree: { createdWithAgent: 'claude' } },
      _meta: { runtimeId: 'r' }
    })
    state.activeSessionTabIdRef.current = null
    state.selectedSessionTabIdRef.current = null
    const apply = mount(state)
    apply(snapshot([setup(true)]))
    apply(snapshot([setup(false), chat(true)]))
    expect(state.activeSessionTabIdRef.current).toBe('setup')
    await act(async () => {})
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('chat')
    expect(state.activeSessionTabIdRef.current).toBe('chat')
    apply(snapshot([setup(true), chat(false)]))
    expect(state.activeSessionTabIdRef.current).toBe('chat')

    state.pendingSelectionRef.current = { kind: 'terminal', handle: 'term_setup', tabId: 'setup' }
    apply(snapshot([setup(false), chat(true)]))
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('setup')
    apply(snapshot([setup(true), chat(false)]))
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('setup')
    expect(state.pendingSelectionRef.current).toBeNull()

    // A host that does not project per device keeps the phone's legacy reader.
    const legacy = scope(null).state
    legacy.selectedSessionTabIdRef.current = null
    const applyLegacy = mount(legacy)
    applyLegacy(snapshot([setup(true)], { publicationEpoch: 'host-epoch' }))
    applyLegacy(snapshot([setup(false), chat(true)], { publicationEpoch: 'host-epoch' }))
    expect(legacy.setActiveSessionTabId).toHaveBeenLastCalledWith('setup')
  })
})

// A host without creation metadata retains the existing no-mid-visit-follow contract.
it('cold opens on the host selection and ignores subsequent desktop navigation without metadata', async () => {
  const { state } = scope(null)
  state.selectedSessionTabIdRef.current = null
  const apply = mount(state)
  await act(async () => {})
  apply(
    snapshot([terminalTab('setup', 'setup', true), { ...chatTab('chat', 's'), isActive: false }])
  )
  apply(
    snapshot([terminalTab('setup', 'setup', false), { ...chatTab('chat', 's'), isActive: true }])
  )
  expect(state.activeSessionTabIdRef.current).toBe('setup')
})
