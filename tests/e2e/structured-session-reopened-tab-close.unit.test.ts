// @vitest-environment happy-dom

/**
 * After /clear the current chat keeps the tab id derived from its first session, so reopening that
 * first session from history lands in a suffixed tab. Closing or focusing the reopened tab from
 * main must reach that tab, not the current chat. Runs the real main close/focus path against the
 * real window store, mirror and IPC bridges; only the process boundary is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ipcMain, type BrowserWindow } from 'electron'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import type { RuntimeRpcResponse } from '../../src/shared/runtime-rpc-envelope'
import type * as RuntimeRpcClient from '../../src/renderer/src/runtime/runtime-rpc-client'
import type * as WorktreeChangeInvalidators from '../../src/main/ipc/worktree-change-invalidators'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { useAppStore } from '../../src/renderer/src/store'
import { applyStructuredSessionTabSnapshots } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../../src/renderer/src/runtime/web-session-tabs-sync'
import { registerSessionTabIpcBridge } from '../../src/renderer/src/hooks/ipc-events/session-tab-ipc-bridge'
import { registerTerminalUiRoutingIpcBridge } from '../../src/renderer/src/hooks/ipc-events/terminal-ui-routing-ipc-bridge'
import { resetWebSessionCloseIntentForTests } from '../../src/renderer/src/runtime/web-session-close-intent'
import { setLocalRuntimeCapabilitiesForTests } from '../../src/renderer/src/runtime/local-runtime-capabilities'
import { SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY } from '../../src/shared/session-tabs-close-capabilities'
import { guardPinnedTabClose } from '../../src/renderer/src/store/pinned-tab-close-guard'
import { registerRuntimeHandlers } from '../../src/main/ipc/runtime'
import { registerRuntimeWindowLifecycle } from '../../src/main/window/runtime-window-lifecycle'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { RuntimeClientSettingsController } from '../../src/main/runtime/runtime-client-settings'

const ipc = vi.hoisted(() => ({ handle: vi.fn(), fromWebContents: vi.fn() }))
vi.mock('electron', async () => {
  const { EventEmitter: Events } = await import('node:events')
  class Main extends Events {
    handle = ipc.handle
    removeHandler = vi.fn()
  }
  return { ipcMain: new Main(), BrowserWindow: { fromWebContents: ipc.fromWebContents } }
})
vi.mock('../../src/main/ipc/worktree-change-invalidators', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeChangeInvalidators>()),
  runWorktreeChangeInvalidators: vi.fn()
}))
vi.mock('../../src/main/window/mobile-markdown-request-relay', () => ({
  requestMobileMarkdownFromRenderer: vi.fn()
}))
vi.mock('../../src/main/window/renderer-document-navigation', () => ({
  registerRendererDocumentNavigation: vi.fn()
}))
vi.mock('../../src/main/window/terminal-tab-close-request-relay', () => ({
  requestTerminalTabCloseFromRenderer: vi.fn()
}))

const WORKTREE = 'repo-1::/tmp/wt-reopen'
const CURRENT_SESSION = 'clear-x'
const REOPENED_SESSION = 'session-s'
const CURRENT_TAB = `structured-agent-session-${REOPENED_SESSION}`
const REOPENED_TAB = `${CURRENT_TAB}:history-1`

type CloseRequest = { requestId: string; tabId: string; worktreeId: string; expiresAt?: number }
type Listener<T> = (payload: T) => void

type ProcessBoundary = {
  runtime: Pick<OrcaRuntimeService, 'closeMobileSessionTab' | 'listMobileSessionTabs'> | null
  rendererSessionCloses: string[]
  call?: (params: {
    worktree: string
    tabId: string
    reason?: 'user'
  }) => Promise<RuntimeRpcResponse<unknown>>
  lastClose?: Promise<RuntimeRpcResponse<unknown>>
}

const bridge = vi.hoisted((): ProcessBoundary => ({
  runtime: null,
  rendererSessionCloses: []
}))

vi.mock('../../src/renderer/src/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClient>()
  return {
    ...actual,
    callRuntimeRpc: async (
      _target: unknown,
      method: string,
      params: { worktree: string; tabId: string; reason?: 'user' }
    ) => {
      // The window's re-read of the worktree after its close settled.
      if (method === 'session.tabs.list') {
        return bridge.runtime!.listMobileSessionTabs(params.worktree)
      }
      if (method !== 'session.tabs.close') {
        throw new Error(`unexpected rpc ${method}`)
      }
      bridge.lastClose = bridge.call!(params)
      return actual.unwrapRuntimeRpcResult(await bridge.lastClose)
    }
  }
})

vi.mock('../../src/renderer/src/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: async (_target: unknown, sessionId: string) => {
    bridge.rendererSessionCloses.push(sessionId)
    return 'closed'
  }
}))

async function setup() {
  const listeners: {
    closeSessionTab?: Listener<{ tabId: string; worktreeId: string }>
    closeRequest?: Listener<CloseRequest>
    focusEditorTab?: Listener<{ tabId: string; worktreeId: string; userInitiated?: boolean }>
  } = {}
  const closeResponses: (string | undefined)[] = []
  const windowEvents = new EventEmitter()
  const contentsEvents = new EventEmitter()
  const mainFrame = {}
  const send = vi.fn((channel: string, payload: CloseRequest) => {
    if (channel === 'ui:sessionTabCloseRequest') {
      listeners.closeRequest?.(payload)
    }
    if (channel === 'ui:focusEditorTab') {
      listeners.focusEditorTab?.(payload)
    }
  })
  const mainWindow = {
    id: 17,
    isDestroyed: () => false,
    on: windowEvents.on.bind(windowEvents),
    once: windowEvents.once.bind(windowEvents),
    removeListener: windowEvents.removeListener.bind(windowEvents),
    webContents: {
      id: 170,
      mainFrame,
      isDestroyed: () => false,
      send,
      on: contentsEvents.on.bind(contentsEvents),
      once: contentsEvents.once.bind(contentsEvents),
      removeListener: contentsEvents.removeListener.bind(contentsEvents)
    }
  }
  const register =
    <T>(assign: (listener: Listener<T>) => void) =>
    (listener: Listener<T>) => {
      assign(listener)
      return () => {}
    }
  const noop = () => () => {}
  vi.stubGlobal('api', {
    ui: {
      onCloseSessionTab: register((l) => (listeners.closeSessionTab = l)),
      onSessionTabCloseRequest: register((l) => (listeners.closeRequest = l)),
      onFocusEditorTab: register((l) => (listeners.focusEditorTab = l)),
      onMoveSessionTab: noop,
      onSplitTerminal: noop,
      onRenameTerminal: noop,
      onFocusTerminal: noop,
      respondSessionTabClose: ({ requestId, error }: { requestId: string; error?: string }) => {
        closeResponses.push(error)
        ipcMain.emit(
          'ui:sessionTabCloseResponse',
          { sender: mainWindow.webContents },
          { requestId, error }
        )
      }
    }
  })
  registerSessionTabIpcBridge([])
  registerTerminalUiRoutingIpcBridge([])

  const hostSessionCloses: string[] = []
  const runtime = new OrcaRuntimeService()
  bridge.runtime = runtime
  ipc.fromWebContents.mockReturnValue(mainWindow)
  registerRuntimeHandlers(runtime)
  const call = ipc.handle.mock.calls.find(([channel]) => channel === 'runtime:call')?.[1]
  if (!call) {
    throw new Error('runtime call handler missing')
  }
  bridge.call = (params) =>
    call(
      { sender: mainWindow.webContents, senderFrame: mainFrame },
      { method: 'session.tabs.close', params }
    )
  registerRuntimeWindowLifecycle(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lifecycle and relay use only the stubbed window identity, events and webContents.
    mainWindow as unknown as BrowserWindow,
    runtime
  )
  const refresh = vi.fn(async () => new Set<string>())
  const closedSessions = new Set<string>()
  // No durable store, PTYs or workspace session on disk: the host tab list below is the whole state.
  Object.assign(runtime, {
    hasPersistedStructuredAgentSessionStore: () => true,
    getKnownWorkspaceSessionWorktreeIds: () => new Set(),
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () => new Set(),
    refreshMobileSessionPtyRecords: refresh,
    ensureStructuredAgentSessionHost: async () => undefined
  })
  vi.spyOn(runtime, 'getClientSettings').mockReturnValue(
    new RuntimeClientSettingsController({
      getSettings: () => ({ ...initialStoreState.settings, experimentalNativeChat: true }),
      updateSettings: vi.fn()
    }).get()
  )
  setStructuredAgentSessionHost(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore and tab close call only these host members.
    {
      reconcileRestartLeases: async () => undefined,
      restoreReadableSessions: async () => undefined,
      close: async (sessionId: string) => {
        hostSessionCloses.push(sessionId)
        closedSessions.add(sessionId)
      },
      setSessionTabVisibility: async () => undefined,
      listSessionTabs: () =>
        [
          { sessionId: CURRENT_SESSION, workspaceId: WORKTREE, agent: 'claude' },
          { sessionId: REOPENED_SESSION, workspaceId: WORKTREE, agent: 'claude' }
        ].filter((session) => !closedSessions.has(session.sessionId))
    } as never
  )
  await runtime.restoreStructuredAgentSessionTabs()
  const hostSnapshot: RuntimeMobileSessionTabsResult = await runtime.listMobileSessionTabs(
    `id:${WORKTREE}`
  )

  // The current chat after /clear: first session's tab id, new session's entity.
  useAppStore.setState({ activeWorktreeId: WORKTREE })
  useAppStore.getState().createUnifiedTab(WORKTREE, 'agent-session', {
    id: CURRENT_TAB,
    entityId: CURRENT_SESSION,
    label: 'Claude Chat'
  })
  applyStructuredSessionTabSnapshots([hostSnapshot])
  const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) =>
    applyStructuredSessionTabSnapshots([snapshot])
  )
  cleanup.push(unsubscribe)

  const agentTabs = () =>
    (useAppStore.getState().unifiedTabsByWorktree[WORKTREE] ?? [])
      .filter((tab) => tab.contentType === 'agent-session')
      .map((tab) => ({ id: tab.id, entityId: tab.entityId }))
  const pin = (): void => {
    useAppStore.setState((state) => ({
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [WORKTREE]: (state.unifiedTabsByWorktree[WORKTREE] ?? []).map((tab) =>
          tab.entityId === REOPENED_SESSION ? { ...tab, isPinned: true } : tab
        )
      }
    }))
  }
  return {
    runtime,
    agentTabs,
    hostSessionCloses,
    closeResponses,
    refresh,
    hostSnapshot,
    pin,
    send,
    mainWindow
  }
}

const initialStoreState = useAppStore.getState()
const cleanup: (() => void)[] = []

beforeEach(() => {
  bridge.rendererSessionCloses = []
  ipc.handle.mockClear()
  ipc.fromWebContents.mockReset()
  bridge.lastClose = undefined
  setLocalRuntimeCapabilitiesForTests([])
})

afterEach(() => {
  for (const unsubscribe of cleanup.splice(0)) {
    unsubscribe()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  ipcMain.removeAllListeners()
  setStructuredAgentSessionHost(null)
  bridge.runtime = null
  useAppStore.setState(initialStoreState, true)
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  // A close's follow-up re-read can outlive its test, which tears the host down under it.
  resetWebSessionCloseIntentForTests()
  vi.unstubAllGlobals()
})

describe('closing a chat reopened from history after /clear', () => {
  it('mirrors the reopened session into a suffixed tab beside the current chat', async () => {
    const { agentTabs } = await setup()

    expect(agentTabs()).toEqual(
      expect.arrayContaining([
        { id: CURRENT_TAB, entityId: CURRENT_SESSION },
        { id: REOPENED_TAB, entityId: REOPENED_SESSION }
      ])
    )
  })

  it('closes only the reopened tab when the user closes it on the desktop', async () => {
    const { agentTabs, hostSessionCloses, closeResponses } = await setup()

    useAppStore.getState().closeUnifiedTab(REOPENED_TAB)

    await vi.waitFor(() => expect(hostSessionCloses).toEqual([REOPENED_SESSION]))
    // Let any stray echo reach the window before asserting the current chat survived.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(agentTabs()).toEqual([{ id: CURRENT_TAB, entityId: CURRENT_SESSION }])
    expect(bridge.rendererSessionCloses).toEqual([REOPENED_SESSION])
    expect(hostSessionCloses).toEqual([REOPENED_SESSION])
    // Main knows the initiating window already closed it, so no redundant relay is created.
    expect(closeResponses).toEqual([])
  })

  it('closes only the reopened tab when a phone closes it through the runtime', async () => {
    const { runtime, agentTabs, hostSessionCloses } = await setup()

    await runtime.closeMobileSessionTab(`id:${WORKTREE}`, `agent-session:${REOPENED_SESSION}`, {
      reason: 'user'
    })

    await vi.waitFor(() =>
      expect(agentTabs()).toEqual([{ id: CURRENT_TAB, entityId: CURRENT_SESSION }])
    )
    expect(bridge.rendererSessionCloses).not.toContain(CURRENT_SESSION)
    expect(hostSessionCloses).not.toContain(CURRENT_SESSION)
  })

  it('focuses the reopened tab when a phone activates it through the runtime', async () => {
    const { runtime } = await setup()
    useAppStore.getState().activateTab(CURRENT_TAB, { worktreeId: WORKTREE })

    await runtime.activateMobileSessionTab(`id:${WORKTREE}`, `agent-session:${REOPENED_SESSION}`)

    const state = useAppStore.getState()
    const group = state.groupsByWorktree[WORKTREE]?.find((candidate) =>
      candidate.tabOrder.includes(REOPENED_TAB)
    )
    expect(group?.activeTabId).toBe(REOPENED_TAB)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('trusted local close origin', () => {
  it.each([
    { delay: 16_000, destroyed: false },
    { delay: 360_000, destroyed: true }
  ])(
    'finishes a confirmed pinned close after $delay ms (origin destroyed=$destroyed)',
    async ({ delay, destroyed }) => {
      const {
        runtime,
        agentTabs,
        hostSessionCloses,
        refresh,
        hostSnapshot,
        pin,
        send,
        mainWindow
      } = await setup()
      setLocalRuntimeCapabilitiesForTests([
        SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY
      ])
      pin()
      const confirm = vi.spyOn(useAppStore.getState(), 'requestPinnedTabCloseConfirm')
      const held = deferred<Set<string>>()
      refresh.mockReturnValueOnce(held.promise)
      vi.useFakeTimers()
      guardPinnedTabClose({
        isPinned: true,
        tabLabel: 'Chat',
        onClose: () => useAppStore.getState().closeUnifiedTab(REOPENED_TAB)
      })
      useAppStore.getState().confirmPinnedTabClose()
      await vi.advanceTimersByTimeAsync(0)
      expect(agentTabs().some((tab) => tab.entityId === REOPENED_SESSION)).toBe(false)
      expect(bridge.lastClose).toBeDefined()
      await vi.advanceTimersByTimeAsync(delay)
      applyStructuredSessionTabSnapshots([hostSnapshot], undefined, {
        reacceptCurrentVersion: true
      })
      pin()
      expect(agentTabs().some((tab) => tab.entityId === REOPENED_SESSION)).toBe(true)
      if (destroyed) {
        vi.spyOn(mainWindow, 'isDestroyed').mockReturnValue(true)
        vi.spyOn(mainWindow.webContents, 'isDestroyed').mockReturnValue(true)
      }
      held.resolve(new Set())
      await expect(bridge.lastClose).resolves.toMatchObject({ ok: true })
      expect(confirm).toHaveBeenCalledOnce()
      expect(
        send.mock.calls.filter(([channel]) => channel === 'ui:sessionTabCloseRequest')
      ).toEqual([])
      expect(hostSessionCloses).toEqual([REOPENED_SESSION])
      expect(bridge.rendererSessionCloses).toEqual([])
      expect(agentTabs()).toEqual([{ id: CURRENT_TAB, entityId: CURRENT_SESSION }])
      expect(
        (await runtime.listMobileSessionTabs(`id:${WORKTREE}`)).tabs.some(
          (tab) => tab.type === 'agent-session' && tab.sessionId === REOPENED_SESSION
        )
      ).toBe(false)
    }
  )

  it.each(['cli', 'other-window', 'missing-window'] as const)(
    'retains independent %s confirmation while the original close is outstanding',
    async (caller) => {
      const { runtime, hostSessionCloses, refresh, hostSnapshot, pin, mainWindow } = await setup()
      setLocalRuntimeCapabilitiesForTests([
        SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY
      ])
      pin()
      const held = deferred<Set<string>>()
      refresh.mockReturnValueOnce(held.promise)
      vi.useFakeTimers()
      guardPinnedTabClose({
        isPinned: true,
        tabLabel: 'Chat',
        onClose: () => useAppStore.getState().closeUnifiedTab(REOPENED_TAB)
      })
      useAppStore.getState().confirmPinnedTabClose()
      await vi.advanceTimersByTimeAsync(16_000)
      applyStructuredSessionTabSnapshots([hostSnapshot], undefined, {
        reacceptCurrentVersion: true
      })
      pin()
      const params = {
        worktree: `id:${WORKTREE}`,
        tabId: `agent-session:${REOPENED_SESSION}`,
        reason: 'user' as const,
        // Untrusted request data must not borrow the original window's confirmation.
        originatingWindowId: mainWindow.id
      }
      ipc.fromWebContents.mockReturnValue(
        caller === 'other-window' ? { id: mainWindow.id + 1 } : null
      )
      const independent =
        caller === 'cli'
          ? new RpcDispatcher({ runtime }).dispatch({
              id: 'independent-close',
              authToken: 'local',
              method: 'session.tabs.close',
              params
            })
          : bridge.call!(params)
      await vi.advanceTimersByTimeAsync(0)
      expect(useAppStore.getState().pinnedTabCloseConfirm).not.toBeNull()
      useAppStore.getState().dismissPinnedTabClose()
      await expect(independent).resolves.toMatchObject({ ok: false })
      expect(hostSessionCloses).toEqual([])
      expect(
        (await runtime.listMobileSessionTabs(`id:${WORKTREE}`)).tabs.some(
          (tab) => tab.type === 'agent-session' && tab.sessionId === REOPENED_SESSION
        )
      ).toBe(true)
      held.resolve(new Set())
      await expect(bridge.lastClose).resolves.toMatchObject({ ok: true })
      expect(hostSessionCloses).toEqual([REOPENED_SESSION])
      expect(useAppStore.getState().pinnedTabCloseConfirm).toBeNull()
    }
  )
})
