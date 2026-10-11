import { createElement, StrictMode, useEffect, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import { useMobileSessionScreenState } from './use-mobile-session-screen-state'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import { useMobileSessionStartup } from './use-mobile-session-startup'
import { useMobileSessionTabApplication } from './use-mobile-session-tab-application'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'
import { MobileSessionRouteScreen } from './MobileSessionRouteScreen'
import type { PendingSessionSelection } from './pending-session-selection'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import { mobileSessionRouteIdentity } from './mobile-session-route'
import {
  editMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'

const route = vi.hoisted(() => {
  const captured: {
    params: { hostId: string; worktreeId: string; paneKey?: string; name?: string }
    current: ReturnType<typeof useTestController> | undefined
    closeReply: Promise<RpcResponse> | undefined
    background: boolean
    clientOverride: { sendRequest: (method: string) => Promise<RpcResponse> } | undefined
    pick: ReturnType<typeof vi.fn>
  } = {
    params: { hostId: 'host-a', worktreeId: 'global-floating-terminal' },
    current: undefined,
    closeReply: undefined,
    background: false,
    clientOverride: undefined,
    pick: vi.fn()
  }
  return captured
})
vi.mock('expo-router', () => ({ useLocalSearchParams: () => route.params }))
vi.mock('react-native', () => ({
  Animated: {
    Value: class {
      constructor(_value: number) {}
    }
  },
  AppState: {
    get currentState() {
      return route.background ? 'background' : 'active'
    }
  }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
vi.mock('../platform/media-picker', () => ({ useMediaPicker: () => ({ pickImages: route.pick }) }))
vi.mock('./use-terminal-live-input-mode-preference', () => ({
  useTerminalLiveInputModePreference: () => ({
    clearTerminalLiveInputDefault: () => {},
    defaultTerminalHandlesToLiveInput: () => {},
    pruneTerminalHandlesFromLiveInput: () => {}
  })
}))
vi.mock('./use-mobile-session-controller', () => ({
  useMobileSessionController: () => useTestController()
}))
vi.mock('./MobileSessionSurface', () => ({
  MobileSessionSurface: ({ controller }: { controller: ReturnType<typeof useTestController> }) => {
    route.current = controller
    return null
  }
}))

const accepted: RpcSuccess = { id: 'close', ok: true, result: {}, _meta: { runtimeId: 'runtime' } }
function tab(): MobileSessionTab {
  return {
    type: 'terminal',
    id: 'tab-1::left',
    parentTabId: 'tab-1',
    leafId: 'left',
    title: 'Terminal',
    terminal: 'term-left',
    isActive: true
  }
}
function useTestController() {
  const { hostId, worktreeId } = route.params
  const state = useMobileSessionScreenState(
    mountFixture<Parameters<typeof useMobileSessionScreenState>[0]>({
      hostId,
      worktreeId,
      initialCreateWarning: ''
    })
  )
  const [ports] = useState(() => ({
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn(),
    cleanup: vi.fn(),
    fetchTerminals: vi.fn(async () => true),
    clearTerminalCache: vi.fn(),
    clearPendingLiveInputCommit: vi.fn(),
    clearDelayedActionTimers: vi.fn(),
    bufferedTerminalDraftState: {
      resetDrafts: vi.fn(),
      clearPendingRestorations: vi.fn(),
      pruneDrafts: vi.fn()
    },
    terminalDiagnostics: { tabsApplied: vi.fn(), resetRoute: vi.fn() },
    client: {
      sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
        if (method === 'clipboard.startImageUpload') {
          return {
            ...accepted,
            ok: false,
            error: { code: 'method_not_found', message: 'Legacy host' }
          }
        }
        if (method === 'clipboard.saveImageAsTempFile') {
          return { ...accepted, result: '/tmp/picture.png' }
        }
        return route.closeReply ?? accepted
      })
    }
  }))
  useEffect(() => () => ports.cleanup(), [ports])
  const client = route.clientOverride ?? ports.client
  const scope = {
    ...state,
    ...ports,
    client,
    hostId,
    worktreeId,
    terminalRefs: useRef(new Map()),
    initializedHandlesRef: useRef(new Set<string>()),
    pendingSelectionRef: useRef<PendingSessionSelection | null>(null),
    pendingBrowserFocusPageIdRef: useRef<string | null>(null),
    activeSessionTabTypeRef: useRef<MobileSessionTab['type'] | null>(null),
    activeHandleRef: useRef<string | null>(null),
    reconcileBufferedDraftsRef: useRef(() => {}),
    initialSessionAutoCreateRef: useRef({ sawSessionTabs: true }),
    terminalDiagnosticsRef: useRef(ports.terminalDiagnostics),
    clientRef: useRef(client),
    sessionTabActionSheetRequestSeqRef: useRef(0),
    sessionTabActionSheetKeyboardHideSubRef: useRef(null),
    pendingTerminalActivationAttemptRef: useRef(null),
    terminalGestureInputQueuesRef: useRef(new Map()),
    terminalGestureInputInFlightRef: useRef(new Set<string>()),
    lastKnownTerminalCountRef: useRef(0),
    showNativeChatRef: useRef(false)
  }
  const close = useMobileSessionCloseActions(
    mountFixture<Parameters<typeof useMobileSessionCloseActions>[0]>(scope)
  )
  const application = useMobileSessionTabApplication(
    mountFixture<Parameters<typeof useMobileSessionTabApplication>[0]>(scope)
  )
  useMobileSessionStartup(
    mountFixture<Parameters<typeof useMobileSessionStartup>[0]>({
      ...scope,
      connState: 'disconnected'
    })
  )
  const draftKey = mobileNativeChatScopeKey(hostId, worktreeId, tab().id)
  const draftText = useMobileNativeChatDraft(draftKey)
  const images = useMobileNativeChatImageAttachments(
    mountFixture<Parameters<typeof useMobileNativeChatImageAttachments>[0]>({
      client,
      activeHandleRef: scope.activeHandleRef,
      deviceTokenRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      scopeKey: draftKey,
      enabled: true,
      structuredNativeChat: true,
      showToast: vi.fn(),
      onSendError: vi.fn(),
      baseSend: async () => 'accepted',
      readSeededLaunchDraft: () => null
    })
  )
  return { ...scope, ...close, ...application, draftText, images }
}
let renderer: ReactTestRenderer | undefined
let strictRenderer = false
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  strictRenderer = false
  route.current = undefined
  route.closeReply = undefined
  route.background = false
  route.clientOverride = undefined
  route.pick.mockReset()
  route.params = { hostId: 'host-a', worktreeId: 'global-floating-terminal' }
  resetMobileNativeChatDraftStoreForTests()
})
function current() {
  if (!route.current) {
    throw new Error('No session controller mounted')
  }
  return route.current
}
function screenElement() {
  const screen = createElement(MobileSessionRouteScreen)
  return strictRenderer ? createElement(StrictMode, null, screen) : screen
}
function render(strict = false) {
  strictRenderer = strict
  act(() => {
    renderer = create(screenElement())
  })
}
function move(params: typeof route.params) {
  route.params = params
  act(() => renderer?.update(screenElement()))
}
function apply() {
  const snapshot: SessionTabsResult = {
    worktree: route.params.worktreeId,
    snapshotVersion: 1,
    tabs: [tab()],
    activeTabId: tab().id,
    activeTabType: 'terminal'
  }
  act(() => {
    current().applySessionTabs(snapshot)
  })
}
function deferReply() {
  let resolve!: (value: RpcResponse) => void
  route.closeReply = new Promise((settle) => {
    resolve = settle
  })
  return async (closing: Promise<void>) => {
    await act(async () => {
      resolve(accepted)
      await closing
    })
  }
}
function startClose() {
  let closing!: Promise<void>
  act(() => {
    closing = current().handleCloseSessionTab(tab())
  })
  return closing
}
function seedSelection() {
  current().selectedSessionTabIdRef.current = tab().id
  current().terminalRefs.current.set('term-left', { marker: 'replacement' })
  current().initializedHandlesRef.current.add('term-left')
  current().unsubscribeTerminal.mockClear()
}
function expectLocalTabIntact() {
  expect(current().sessionTabsRef.current.map((item) => item.id)).toEqual([tab().id])
  expect(current().activeSessionTabIdRef.current).toBe(tab().id)
  expect(current().selectedSessionTabIdRef.current).toBe(tab().id)
  expect(current().terminalRefs.current.has('term-left')).toBe(true)
  expect(current().initializedHandlesRef.current.has('term-left')).toBe(true)
  expect(current().unsubscribeTerminal).not.toHaveBeenCalled()
}

describe('a close completion belongs to its route activation', () => {
  it('keeps ownership intact through StrictMode setup/cleanup and navigation', async () => {
    const finish = deferReply()
    render(true)
    apply()
    const closing = startClose()
    move({ ...route.params, hostId: 'host-b' })
    apply()
    seedSelection()
    await finish(closing)
    expectLocalTabIntact()
  })

  it.each([
    { hostId: 'host-b', worktreeId: 'global-floating-terminal' },
    { hostId: 'host-a', worktreeId: 'folder:another-workspace' }
  ])(
    'keeps the replacement local state intact after a late close: $hostId/$worktreeId',
    async (nextRoute) => {
      const finish = deferReply()
      render()
      apply()
      const old = current()
      const closing = startClose()
      move(nextRoute)
      apply()
      seedSelection()
      await finish(closing)
      expectLocalTabIntact()
      expect(current().cleanup).toBe(old.cleanup)
      expect(old.cleanup).not.toHaveBeenCalled()
      expect(old.closedTabLedger.hasPending(old.closedTabPartition, Date.now())).toBe(true)
      expect(current().closedTabLedger.hasPending(current().closedTabPartition, Date.now())).toBe(
        false
      )
      apply()
      expectLocalTabIntact()
    }
  )

  it('retires the first activation on A-B-A without losing the accepted host fact', async () => {
    const finish = deferReply()
    render()
    apply()
    const old = current()
    const original = route.params
    const closing = startClose()
    move({ ...original, hostId: 'host-b' })
    move(original)
    apply()
    seedSelection()
    await finish(closing)
    expectLocalTabIntact()
    expect(current().cleanup).toBe(old.cleanup)
    expect(old.closedTabLedger.hasPending(old.closedTabPartition, Date.now())).toBe(true)
  })

  it('retires a close when the client instance changes on the same route', async () => {
    const finish = deferReply()
    render()
    apply()
    const old = current()
    const closing = startClose()
    route.clientOverride = { sendRequest: old.client.sendRequest }
    move({ ...route.params })
    seedSelection()
    await finish(closing)
    expectLocalTabIntact()
    expect(old.closedTabLedger.hasPending(old.closedTabPartition, Date.now())).toBe(true)
  })

  it('records a close after unmount without pruning the retired local state', async () => {
    const finish = deferReply()
    render()
    apply()
    seedSelection()
    const old = current()
    const closing = startClose()
    act(() => renderer?.unmount())
    renderer = undefined
    await finish(closing)
    expect(old.sessionTabsRef.current.map((item) => item.id)).toEqual([tab().id])
    expect(old.activeSessionTabIdRef.current).toBe(tab().id)
    expect(old.selectedSessionTabIdRef.current).toBe(tab().id)
    expect(old.unsubscribeTerminal).not.toHaveBeenCalled()
    expect(old.closedTabLedger.hasPending(old.closedTabPartition, Date.now())).toBe(true)
    expect(old.cleanup).toHaveBeenCalledOnce()
  })

  it('settles a close while the same route is backgrounded', async () => {
    const finish = deferReply()
    render()
    apply()
    const closing = startClose()
    route.background = true
    move({ ...route.params })
    await finish(closing)
    expect(current().sessionTabsRef.current).toEqual([])
    expect(current().unsubscribeTerminal).toHaveBeenCalledWith('term-left')
    expect(current().closedTabLedger.hasPending(current().closedTabPartition, Date.now())).toBe(
      true
    )
  })

  it('keeps pane/name changes and composer input on the current activation', async () => {
    const finish = deferReply()
    render()
    apply()
    const old = current()
    act(() => old.setInput('typed input'))
    old.tabStripOffsetRef.current = 240
    const closing = startClose()
    move({ ...route.params, paneKey: 'agent-session:another', name: 'Renamed workspace' })
    expect(current().input).toBe('typed input')
    expect(current().tabStripOffsetRef.current).toBe(240)
    await finish(closing)
    expect(current().sessionTabsRef.current).toEqual([])
    expect(old.cleanup).not.toHaveBeenCalled()
  })

  it.each([
    { hostId: 'host-b', worktreeId: 'global-floating-terminal' },
    { hostId: 'host-a', worktreeId: 'folder:another-workspace' }
  ])(
    'preserves separate text and unsent image chips on revisit: $hostId/$worktreeId',
    async (nextRoute) => {
      render()
      const original = route.params
      const originalController = current()
      act(() =>
        editMobileNativeChatDraft(
          mobileNativeChatScopeKey(original.hostId, original.worktreeId, tab().id)!,
          'draft A'
        )
      )
      route.pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
      await act(async () => {
        await current().images.attachImage('library')
      })
      expect(current().images.attachments.map((image) => image.previewUri)).toEqual([
        'file:///a.jpg'
      ])
      move(nextRoute)
      expect(current().images.attachments).toEqual([])
      act(() =>
        editMobileNativeChatDraft(
          mobileNativeChatScopeKey(nextRoute.hostId, nextRoute.worktreeId, tab().id)!,
          'draft B'
        )
      )
      route.pick.mockResolvedValue([{ base64: 'BBBB', uri: 'file:///b.jpg' }])
      await act(async () => {
        await current().images.attachImage('library')
      })
      move(original)
      expect(current().draftText).toBe('draft A')
      expect(current().images.attachments.map((image) => image.previewUri)).toEqual([
        'file:///a.jpg'
      ])
      move(nextRoute)
      expect(current().draftText).toBe('draft B')
      expect(current().images.attachments.map((image) => image.previewUri)).toEqual([
        'file:///b.jpg'
      ])
      expect(originalController.cleanup).not.toHaveBeenCalled()
      expect(current().cleanup).toBe(originalController.cleanup)
      expect(current().closedTabPartition).toBe(
        mobileSessionRouteIdentity(nextRoute.hostId, nextRoute.worktreeId)
      )
    }
  )
})
