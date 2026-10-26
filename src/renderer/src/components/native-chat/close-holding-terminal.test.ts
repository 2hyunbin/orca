// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { preparePendingSplitClose } from '../terminal-pane/pending-split-close-test-fixture'
import { capturedPinnedTerminalCloseRequest } from '../../../../shared/__fixtures__/captured-pinned-terminal-close.test-fixture'
import { TerminalClose } from '../../../../shared/rpc-contract/terminal-unary-params'
import type * as RuntimeEnvironmentRevisionModule from '@/runtime/runtime-environment-revision'
import type * as AppStoreModule from '@/store'
import type * as HoldingTerminalModule from './close-holding-terminal'
let replaceRuntimeEnvironmentRevisions: typeof RuntimeEnvironmentRevisionModule.replaceRuntimeEnvironmentRevisions
import type * as PtyDispatcherModule from '../terminal-pane/pty-dispatcher'
import type { TerminalPaneCloseCallbacks } from '@/constants/terminal'
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  supportsPinCloseConsent: true,
  request: vi.fn(),
  exit: vi.fn(),
  subscribe: vi.fn(),
  reveal: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/lib/reveal-terminal-pane', () => ({ revealTerminalPane: mocks.reveal }))
vi.mock('../terminal-pane/request-active-terminal-pane-close', () => ({
  requestActiveTerminalPaneClose: mocks.request
}))
vi.mock('../terminal-pane/terminal-delivery-watchdog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startTerminalDeliveryWatchdog: vi.fn()
}))
vi.mock('../terminal-pane/terminal-freeze-report', () => ({ installTerminalFreezeReport: vi.fn() }))
vi.mock('../terminal-pane/pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof PtyDispatcherModule>()
  mocks.subscribe.mockImplementation(actual.subscribeToPtyExit)
  return { ...actual, subscribeToPtyExit: mocks.exit }
})
import type { HeldTerminalTarget } from './native-chat-held-terminal'
const { useAppStore } = await vi.importActual<typeof AppStoreModule>('@/store')
let closeHoldingTerminal: typeof HoldingTerminalModule.closeHoldingTerminal
let HOLDING_TERMINAL_EXIT_TIMEOUT_MS: number
const original = useAppStore.getState()
const request = capturedPinnedTerminalCloseRequest('handle')
const { identity } = request.originalPresentation
const target = {
  ...identity,
  executionHostId: 'local' as const,
  ptyId: identity.ptyId ?? '',
  incarnationId: request.expectedIncarnationId,
  paneKey: `${identity.tabId}:${identity.leafId}`,
  title: 'Build'
}
const worktree = target.worktreeId,
  tab = target.tabId,
  life = target.incarnationId
let callbacks: TerminalPaneCloseCallbacks
let exit: (code: number, context: { hadPrimary: boolean; incarnationId?: string }) => void
let spawned: (event: { id: string; incarnationId?: string }) => void
let dispatchExit: (payload: { id: string; code: number; incarnationId?: string }) => void
let frame: FrameRequestCallback
let closing: ReturnType<typeof Promise.withResolvers<{ close: { ptyKilled: boolean } }>>
const unsubscribe = vi.fn()
const activeWatchers = new Set<() => void>()
beforeEach(async () => {
  vi.doMock('../../store', () => ({ useAppStore }))
  ;({ replaceRuntimeEnvironmentRevisions } = await import('@/runtime/runtime-environment-revision'))
  ;({ closeHoldingTerminal, HOLDING_TERMINAL_EXIT_TIMEOUT_MS } =
    await import('./close-holding-terminal'))
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.supportsPinCloseConsent = true
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
    frame = run
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  Object.assign(window.api.pty, {
    onSpawned: (listener: typeof spawned) => {
      spawned = listener
      return () => {}
    },
    onData: () => () => {},
    onReplay: () => () => {},
    onExit: (listener: typeof dispatchExit) => {
      dispatchExit = listener
      return () => {}
    }
  })
  useAppStore.setState({
    activeWorktreeId: 'origin',
    activeWorkspaceExecutionHostId: 'local',
    activeView: 'terminal',
    tabsByWorktree: {
      [worktree]: [
        {
          id: tab,
          worktreeId: worktree,
          title: 'Build',
          customTitle: null,
          ptyId: target.ptyId,
          color: null,
          createdAt: 1,
          sortOrder: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tab]: {
        root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
        activeLeafId: '11111111-1111-4111-8111-111111111111',
        expandedLeafId: null,
        ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': target.ptyId }
      }
    },
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    setActiveWorktree: (id, host) => {
      useAppStore.setState({ activeWorktreeId: id, activeWorkspaceExecutionHostId: host ?? null })
      return true
    },
    setActiveView: (view) => useAppStore.setState({ activeView: view })
  })
  closing = Promise.withResolvers()
  mocks.rpc.mockImplementation(async (_target, method) => {
    if (method === 'terminal.close') {
      return closing.promise
    }
    return {
      terminal: {
        handle: 'handle',
        ptyId: target.ptyId,
        incarnationId: life,
        supportsPinCloseConsent: mocks.supportsPinCloseConsent,
        presentation: request.originalPresentation
      }
    }
  })
  mocks.request.mockImplementation((_tab, options) => {
    callbacks = options
    return true
  })
  mocks.exit.mockImplementation((pty, listener) => {
    const stopReal = mocks.subscribe(
      pty,
      (code: number, context: { hadPrimary: boolean; incarnationId?: string }) => {
        activeWatchers.delete(stop)
        listener(code, context)
      }
    )
    const stop = () => {
      stopReal()
      activeWatchers.delete(stop)
      unsubscribe()
    }
    activeWatchers.add(stop)
    exit = (code, context) => dispatchExit({ id: pty, code, incarnationId: context.incarnationId })
    return stop
  })
  mocks.reveal.mockImplementation(() => {
    if (!useAppStore.getState().isNavigatingHistory) {
      useAppStore.getState().recordWorktreeVisit(worktree)
    }
    useAppStore.setState({ activeWorktreeId: worktree })
    return true
  })
  replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 1 }])
})
afterEach(() => {
  useAppStore.setState(original)
  activeWatchers.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function begin(input: HeldTerminalTarget = target) {
  const reveals = mocks.reveal.mock.calls.length
  const result = closeHoldingTerminal(input)
  await vi.waitFor(() => expect(mocks.reveal).toHaveBeenCalledTimes(reveals + 1))
  frame(0)
  return { result }
}
it('uses host-captured incarnation without a renderer map, subscribes before consent, and restores origin while awaiting actual exit', async () => {
  const chat = useAppStore.getState().createUnifiedTab('origin', 'agent-session', {
    entityId: 'chat',
    executionHostId: 'local'
  })
  useAppStore.getState().activateTab(chat.id, { worktreeId: 'origin' })
  const history = useAppStore.getState().worktreeNavHistory
  const { result } = await begin()
  expect(useAppStore.getState().worktreeNavHistory).toBe(history)
  expect(mocks.exit.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.request.mock.invocationCallOrder[0]
  )
  expect(mocks.rpc).toHaveBeenCalledTimes(1)
  callbacks.onConfirm?.()
  expect(mocks.rpc.mock.calls.at(-1)?.[2]).not.toHaveProperty('force')
  expect(useAppStore.getState().activeWorktreeId).toBe('origin')
  expect(
    useAppStore.getState().groupsByWorktree.origin.find((g) => g.id === chat.groupId)?.activeTabId
  ).toBe(chat.id)
  const later = useAppStore.getState().createUnifiedTab('origin', 'agent-session', {
    entityId: 'later-chat',
    executionHostId: 'local'
  })
  useAppStore.getState().activateTab(later.id, { worktreeId: 'origin' })
  useAppStore.setState({ tabsByWorktree: {} })
  exit(0, { hadPrimary: false, incarnationId: 'replacement' })
  expect(activeWatchers.size).toBe(1)
  exit(0, { hadPrimary: false, incarnationId: life })
  expect(await result).toBe(true)
  expect(
    useAppStore.getState().groupsByWorktree.origin.find((g) => g.id === later.groupId)?.activeTabId
  ).toBe(later.id)
  expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual([
    'terminal.resolvePane',
    'terminal.close'
  ])
  expect(vi.getTimerCount()).toBe(0)
})
it('preserves the chat in its retired terminal source slot when a different holder closes', async () => {
  useAppStore.setState({ activeWorktreeId: worktree })
  const state = useAppStore.getState()
  const source = state.createUnifiedTab(worktree, 'terminal', {
    entityId: 'switched-source',
    executionHostId: 'local'
  })
  const chat = state.createUnifiedTab(worktree, 'agent-session', {
    entityId: 'returned-chat',
    executionHostId: 'local'
  })
  const holder = state.createUnifiedTab(worktree, 'terminal', {
    entityId: tab,
    executionHostId: 'local'
  })
  // The in-place switch publishes after its source, then retires that source.
  state.reorderUnifiedTabs(source.groupId, [source.id, chat.id, holder.id])
  state.closeUnifiedTab(source.id)
  state.activateTab(chat.id, { worktreeId: worktree })
  const before = useAppStore
    .getState()
    .unifiedTabsByWorktree[worktree].find((t) => t.id === chat.id)
  const { result } = await begin()
  callbacks.onConfirm?.()
  state.closeUnifiedTab(holder.id)
  useAppStore.setState({ tabsByWorktree: { [worktree]: [] } })
  exit(0, { hadPrimary: false, incarnationId: life })
  expect(await result).toBe(true)
  const after = useAppStore.getState()
  expect(after.unifiedTabsByWorktree[worktree]).toEqual([before])
  expect(after.groupsByWorktree[worktree].find((g) => g.id === chat.groupId)).toMatchObject({
    tabOrder: [chat.id],
    activeTabId: chat.id
  })
  expect(after.activeWorktreeId).toBe(worktree)
  expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual([
    'terminal.resolvePane',
    'terminal.close'
  ])
})
it.each(['cancel', 'replace', 'navigate', 'timeout', 'host-loss', 'spawn'] as const)(
  'settles %s without a follow-up or stolen navigation',
  async (outcome) => {
    const { result } = await begin()
    if (outcome === 'spawn') {
      spawned({ id: target.ptyId, incarnationId: 'replacement' })
    }
    if (outcome === 'cancel') {
      callbacks.onCancel?.()
    }
    if (outcome === 'replace') {
      useAppStore.setState({
        terminalLayoutsByTabId: {
          [tab]: {
            ...useAppStore.getState().terminalLayoutsByTabId[tab],
            ptyIdsByLeafId: { [target.leafId]: 'replacement' }
          }
        }
      })
      expect(callbacks.isCurrent?.()).toBe(false)
      callbacks.onConfirm?.()
    }
    if (outcome === 'navigate') {
      useAppStore.setState({ activeWorktreeId: 'later' })
    }
    if (outcome === 'host-loss') {
      callbacks.onConfirm?.()
      exit(-1, { hadPrimary: false, incarnationId: life })
    }
    if (outcome === 'timeout') {
      callbacks.onConfirm?.()
      await vi.advanceTimersByTimeAsync(HOLDING_TERMINAL_EXIT_TIMEOUT_MS)
    }
    expect(await result).toBe(false)
    expect(useAppStore.getState().activeWorktreeId).toBe(
      outcome === 'navigate' ? 'later' : 'origin'
    )
    expect(mocks.rpc).toHaveBeenCalledTimes(
      outcome === 'timeout' || outcome === 'host-loss' ? 2 : 1
    )
    expect(vi.getTimerCount()).toBe(0)
  }
)
it.each(['current', 'replaced', 'malformed'] as const)(
  'checks paired completion without requiring removed presentation, result=%s',
  async (outcome) => {
    const paired = {
      ...target,
      executionHostId: 'runtime:host' as const,
      tabId: `web-terminal-${tab}`,
      paneKey: `web-terminal-${target.paneKey}`,
      ptyId: 'remote:host@@handle'
    }
    useAppStore.setState({
      tabsByWorktree: {
        [worktree]: useAppStore
          .getState()
          .tabsByWorktree[worktree].map((tab) => ({ ...tab, id: paired.tabId }))
      },
      terminalLayoutsByTabId: {
        [paired.tabId]: {
          ...useAppStore.getState().terminalLayoutsByTabId[tab],
          ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': paired.ptyId }
        }
      }
    })
    const call = vi.fn().mockImplementation(async () => {
      const result = await closing.promise
      return { ok: true, result: outcome === 'malformed' ? null : result }
    })
    Object.assign(window.api, { runtimeEnvironments: { call } })
    const { result } = await begin(paired)
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'host' },
      'terminal.resolvePane',
      { paneKey: target.paneKey, worktreeId: worktree }
    )
    callbacks.onConfirm?.(true)
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'host',
        expectedEnvironmentPairingRevision: 1,
        method: 'terminal.close',
        params: expect.objectContaining({ force: true })
      })
    )
    useAppStore.setState({ tabsByWorktree: {} })
    if (outcome === 'replaced') {
      replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 2 }])
    }
    closing.resolve({ close: { ptyKilled: true } })
    expect(await result).toBe(outcome === 'current')
  }
)
it.each([1, 10])(
  'releases every preconsent observer/frame for %s cancelled attempts',
  async (count) => {
    for (let i = 0; i < count; i++) {
      const { result } = await begin()
      callbacks.onCancel?.()
      expect(await result).toBe(false)
    }
    expect(mocks.exit).toHaveBeenCalledTimes(count)
    expect(unsubscribe).toHaveBeenCalledTimes(count)
    expect(activeWatchers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('fresh unsupported capture refuses before reveal or confirmation', async () => {
  mocks.supportsPinCloseConsent = false
  expect(await closeHoldingTerminal(target)).toBe(false)
  expect(mocks.reveal).not.toHaveBeenCalled()
  expect(mocks.request).not.toHaveBeenCalled()
})

it.each([false, true])(
  'real final-pane consent emits the shared parsed request, prompt=%s',
  async (prompt) => {
    const pane = await preparePendingSplitClose(target.ptyId, worktree, tab)
    const manager = pane.controller.managerRef.current
    if (!manager) {
      throw new Error('Missing pane manager')
    }
    vi.spyOn(manager, 'getPanes').mockReturnValue(manager.getPanes().slice(0, 1))
    const pin = vi.fn<(request: { onConfirm: () => void; onCancel?: () => void }) => void>()
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, confirmClosePinnedTab: prompt },
      requestPinnedTabCloseConfirm: pin
    })
    const unified = useAppStore
      .getState()
      .createUnifiedTab(worktree, 'terminal', { entityId: tab, executionHostId: 'local' })
    useAppStore.getState().pinTab(unified.id, { recordInteraction: false })
    const { closeTerminalTab } = await import('../terminal/terminal-tab-actions')
    vi.mocked(pane.controller.onCloseTab).mockImplementation((options) =>
      closeTerminalTab(tab, { ...options, skipRunningProcessConfirm: true })
    )
    mocks.request.mockImplementation((_tab: string, options: TerminalPaneCloseCallbacks) => {
      pane.actions.handleRequestClosePane(1, options)
      return true
    })
    if (prompt) {
      const { result } = await begin()
      pin.mock.calls[0][0].onCancel?.()
      expect(await result).toBe(false)
      expect(mocks.rpc.mock.calls.filter(([, method]) => method === 'terminal.close')).toHaveLength(
        0
      )
    }
    const { result } = await begin()
    if (prompt) {
      pin.mock.calls[1][0].onConfirm()
    }
    const emitted = mocks.rpc.mock.calls.find(([, method]) => method === 'terminal.close')?.[2]
    expect(emitted).toEqual(request)
    expect(TerminalClose.parse(emitted)).toEqual(TerminalClose.parse(request))
    for (const force of [false, null, 'true']) {
      expect(TerminalClose.safeParse({ ...request, force }).success).toBe(false)
    }
    for (const omitted of ['expectedIncarnationId', 'originalPresentation'] as const) {
      expect(TerminalClose.safeParse({ ...request, [omitted]: undefined }).success).toBe(false)
    }
    expect(TerminalClose.safeParse({ terminal: request.terminal, force: true }).success).toBe(false)
    expect(TerminalClose.parse({ terminal: request.terminal })).toEqual({
      terminal: request.terminal
    })
    closing.resolve({ close: { ptyKilled: true } })
    expect(await result).toBe(true)
    expect(mocks.rpc.mock.calls.filter(([, method]) => method === 'terminal.close')).toHaveLength(1)
    pane.spawn.resolve({ id: target.ptyId, isReattach: true })
    await pane.connecting
  }
)
