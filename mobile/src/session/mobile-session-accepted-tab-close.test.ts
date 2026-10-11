import { describe, expect, it, vi } from 'vitest'
import { SessionTabCloseLedger } from '../../../src/shared/session-tab-close-ledger'
import { hookMount, performHookAction } from '../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcResponse } from '../transport/types'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import { useMobileSessionTabApplication } from './use-mobile-session-tab-application'
import { useMobileSessionTabReconciliation } from './use-mobile-session-tab-reconciliation'

const reconciliation = vi.hoisted(() => {
  const captured: { hasRecoveryNeed: (() => boolean) | null } = { hasRecoveryNeed: null }
  return captured
})

vi.mock('./use-mobile-session-tabs-reconciliation', () => ({
  useMobileSessionTabsReconciliation(params: { hasRecoveryNeed: () => boolean }) {
    reconciliation.hasRecoveryNeed = params.hasRecoveryNeed
    return { requestTerminalInventoryRecovery: () => {} }
  }
}))

const WT = 'wt-1'
const META = { runtimeId: 'runtime-1' }
const accepted: RpcResponse = { id: 'reply', ok: true, result: {}, _meta: META }
const refused: RpcResponse = {
  id: 'reply',
  ok: false,
  error: { code: 'runtime_error', message: 'Unable to close' },
  _meta: META
}

function file(id: string): MobileSessionTab {
  return {
    type: 'file',
    id,
    title: id,
    filePath: `/w/${id}`,
    relativePath: id,
    isDirty: false,
    isActive: false
  }
}

function pane(parent: string, leaf: string): MobileSessionTab {
  return {
    type: 'terminal',
    id: `${parent}::${leaf}`,
    parentTabId: parent,
    leafId: leaf,
    title: 'T',
    terminal: `term-${leaf}`,
    isActive: false
  }
}

function sessionScreen(initialTabs: MobileSessionTab[]) {
  const closedTabLedger = new SessionTabCloseLedger()
  const sessionTabsRef = { current: initialTabs }
  let closeReply: RpcResponse | Error = accepted
  let version = 0
  const client = {
    sendRequest: vi.fn(async (method: string) => {
      if (method !== 'session.tabs.close') {
        return accepted
      }
      if (closeReply instanceof Error) {
        throw closeReply
      }
      return closeReply
    })
  }
  const refs = {
    activeSessionTabIdRef: { current: null },
    selectedSessionTabIdRef: { current: null },
    activeSessionTabTypeRef: { current: null },
    activeHandleRef: { current: null },
    pendingSelectionRef: { current: null },
    pendingBrowserFocusPageIdRef: { current: null },
    initializedHandlesRef: { current: new Set<string>() },
    reconcileBufferedDraftsRef: { current: () => {} }
  }
  let closeActions: ReturnType<typeof useMobileSessionCloseActions> | undefined
  let application: ReturnType<typeof useMobileSessionTabApplication> | undefined
  const hook = hookMount(() => {
    closeActions = useMobileSessionCloseActions(
      mountFixture<Parameters<typeof useMobileSessionCloseActions>[0]>({
        ...refs,
        worktreeId: WT,
        client,
        sessionTabsRef,
        setSessionTabs: () => {},
        closedTabLedger,
        closedTabPartition: WT,
        hostId: 'test-host',
        setFileDocs: () => {},
        terminalRefs: { current: new Map() },
        unsubscribeTerminal: () => {},
        clearTerminalLiveInputDefault: () => {},
        setActiveSessionTabId: () => {},
        setActiveHandle: () => {}
      })
    )
    application = useMobileSessionTabApplication(
      mountFixture<Parameters<typeof useMobileSessionTabApplication>[0]>({
        ...refs,
        worktreeId: WT,
        sessionTabsRef,
        setSessionTabs: () => {},
        closedTabLedger,
        closedTabPartition: WT,
        appliedSnapshotMarkerRef: { current: { epoch: null, version: -1 } },
        appliedSessionTabsRevisionRef: { current: 0 },
        markdownDocsRef: { current: new Map() },
        initialSessionAutoCreateRef: { current: { sawSessionTabs: true } },
        terminalsRef: { current: [] },
        setTerminals: () => {},
        defaultTerminalHandlesToLiveInput: () => {},
        lastKnownTerminalCountRef: { current: 0 },
        setTerminalsLoaded: () => {},
        terminalDiagnosticsRef: { current: { tabsApplied: () => {} } },
        setActiveSessionTabId: () => {},
        setActiveHandle: () => {},
        subscribeToTerminal: () => {},
        unsubscribeTerminal: () => {},
        clientRef: { current: client }
      })
    )
    useMobileSessionTabReconciliation(
      mountFixture<Parameters<typeof useMobileSessionTabReconciliation>[0]>({
        ...refs,
        worktreeId: WT,
        client: null,
        connState: 'disconnected',
        sessionTabsRef,
        terminalsRef: { current: [] },
        closedTabLedger,
        closedTabPartition: WT,
        nativeChatStream: { hasTabsRecoveryNeed: () => false },
        terminalGestureInputQueuesRef: { current: new Map() },
        terminalGestureInputInFlightRef: { current: new Set() },
        terminalDiagnosticsRef: { current: {} },
        registerTerminalInventoryRecoveryAction: () => () => {},
        setBrowserScreencastSupported: () => {},
        setAgentSessionHistorySupported: () => {},
        setAgentSessionHostSupport: () => {},
        setQuickCommandsSupported: () => {},
        setShowQuickCommands: () => {}
      })
    )
  })
  hook.mount()
  return {
    visibleIds: () => sessionTabsRef.current.map((tab) => tab.id),
    pollingForCloses: () => reconciliation.hasRecoveryNeed?.() ?? false,
    setCloseReply(reply: RpcResponse | Error) {
      closeReply = reply
    },
    close(tab: MobileSessionTab) {
      const actions = closeActions!
      return performHookAction(() => actions.handleCloseSessionTab(tab))
    },
    applyHostList(tabs: MobileSessionTab[]) {
      version += 1
      const result: SessionTabsResult = {
        worktree: WT,
        snapshotVersion: version,
        tabs,
        activeTabId: null,
        activeTabType: null
      }
      const actions = application!
      performHookAction(() => actions.applySessionTabs(result))
    },
    dispose: hook.unmount
  }
}

describe('a tab the host accepted closing', () => {
  it('ends screen recovery at the backstop without applying another host list', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const screen = sessionScreen([file('a'), file('b')])
    try {
      await screen.close(file('a'))
      expect(screen.pollingForCloses()).toBe(true)
      clock.mockReturnValue(21_001)
      expect(screen.pollingForCloses()).toBe(false)
      expect(screen.visibleIds()).toEqual(['b'])
    } finally {
      screen.dispose()
      clock.mockRestore()
    }
  })

  it('stays hidden from host lists that still name it and ends at the first list without it', async () => {
    const screen = sessionScreen([file('a'), file('b')])
    try {
      expect(screen.pollingForCloses()).toBe(false)
      await screen.close(file('a'))
      expect(screen.visibleIds()).toEqual(['b'])
      expect(screen.pollingForCloses()).toBe(true)

      screen.applyHostList([file('a'), file('b')])
      expect(screen.visibleIds()).toEqual(['b'])
      expect(screen.pollingForCloses()).toBe(true)

      screen.applyHostList([file('b')])
      expect(screen.pollingForCloses()).toBe(false)
      // The close ended, so a tab the host lists again under that id shows.
      screen.applyHostList([file('a'), file('b')])
      expect(screen.visibleIds()).toEqual(['a', 'b'])
    } finally {
      screen.dispose()
    }
  })

  it('records nothing when the host refuses the close', async () => {
    const screen = sessionScreen([file('a'), file('b')])
    try {
      screen.setCloseReply(refused)
      await screen.close(file('a'))
      expect(screen.visibleIds()).toEqual(['a', 'b'])
      expect(screen.pollingForCloses()).toBe(false)
      screen.applyHostList([file('a'), file('b')])
      expect(screen.visibleIds()).toEqual(['a', 'b'])
    } finally {
      screen.dispose()
    }
  })

  it('keeps a live tab when a successful reply refuses the close and republishes it', async () => {
    const liveTabs = [pane('tab', 'left'), pane('tab', 'right')]
    const screen = sessionScreen(liveTabs)
    try {
      screen.setCloseReply({
        ...accepted,
        result: {
          closed: true,
          refused: true,
          refusalReason: 'stale-terminal',
          snapshotRepublished: true
        }
      })
      await screen.close(pane('tab', 'left'))
      expect(screen.visibleIds()).toEqual(['tab::left', 'tab::right'])
      expect(screen.pollingForCloses()).toBe(false)
      screen.applyHostList(liveTabs)
      expect(screen.visibleIds()).toEqual(['tab::left', 'tab::right'])
    } finally {
      screen.dispose()
    }
  })

  it('keeps the desktop dead-leaf policy when a refusal republishes no tab', async () => {
    const screen = sessionScreen([pane('tab', 'left'), pane('tab', 'right')])
    try {
      screen.setCloseReply({
        ...accepted,
        result: { closed: true, refused: true, refusalReason: 'live-host-pty' }
      })
      await screen.close(pane('tab', 'left'))
      expect(screen.visibleIds()).toEqual(['tab::right'])
      expect(screen.pollingForCloses()).toBe(true)
    } finally {
      screen.dispose()
    }
  })

  it.each([null, undefined])('keeps legacy success compatible with result %s', async (result) => {
    const screen = sessionScreen([file('a'), file('b')])
    try {
      screen.setCloseReply({ ...accepted, result })
      await screen.close(file('a'))
      expect(screen.visibleIds()).toEqual(['b'])
      expect(screen.pollingForCloses()).toBe(true)
    } finally {
      screen.dispose()
    }
  })

  it('keeps the tab and records nothing when transport fails', async () => {
    const screen = sessionScreen([file('a'), file('b')])
    try {
      screen.setCloseReply(new Error('Connection lost'))
      await screen.close(file('a'))
      expect(screen.visibleIds()).toEqual(['a', 'b'])
      expect(screen.pollingForCloses()).toBe(false)
    } finally {
      screen.dispose()
    }
  })

  it('hides only the closed pane of a split terminal', async () => {
    const screen = sessionScreen([pane('tab', 'left'), pane('tab', 'right')])
    try {
      await screen.close(pane('tab', 'left'))
      screen.applyHostList([pane('tab', 'left'), pane('tab', 'right'), file('b')])
      expect(screen.visibleIds()).toEqual(['tab::right', 'b'])
    } finally {
      screen.dispose()
    }
  })
})
