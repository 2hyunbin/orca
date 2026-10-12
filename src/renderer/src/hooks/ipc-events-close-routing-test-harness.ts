/* oxlint-disable anti-slop/no-module-mocking -- Vitest support module for the 3 close-routing ipc-events specs, not shipped code, and it falls
   outside the *.test / *.spec / tests glob set. The stubs and the hook invocation are one unit; splitting the 9 doMock
   calls back out would duplicate them into all 3 specs. */
import type * as ReactModule from 'react'
import { vi } from 'vitest'

export type CloseActiveTabListener = (payload?: { sourceId: string }) => void
export type CloseFloatingItemListener = (payload: { sourceId: string }) => void
export type SelectFloatingIndexListener = (payload: { index: number }) => void

export async function useIpcEventsForCloseRouting({
  closeActiveTabListenerRef,
  closeFloatingItemListenerRef,
  selectFloatingIndexListenerRef,
  getState
}: {
  closeActiveTabListenerRef?: { current: CloseActiveTabListener | null }
  closeFloatingItemListenerRef?: { current: CloseFloatingItemListener | null }
  selectFloatingIndexListenerRef?: { current: SelectFloatingIndexListener | null }
  getState: () => Record<string, unknown>
}): Promise<void> {
  if (typeof HTMLElement === 'undefined') {
    vi.stubGlobal('HTMLElement', class {})
  }
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return {
      ...actual,
      useEffect: (effect: () => void | (() => void)) => {
        effect()
      }
    }
  })

  const appStoreModule = {
    useAppStore: {
      subscribe: vi.fn(() => () => {}),
      getState: () => ({
        getActiveTab: () => null,
        closeUnifiedTab: vi.fn(),
        reconcileWorktreeTabModel: () => ({ renderableTabCount: 1 }),
        setUpdateStatus: vi.fn(),
        fetchRepos: vi.fn(),
        fetchWorktrees: vi.fn(),
        setActiveView: vi.fn(),
        activeModal: null,
        closeModal: vi.fn(),
        openModal: vi.fn(),
        activeWorktreeId: 'wt-1',
        activeView: 'terminal',
        setActiveRepo: vi.fn(),
        setActiveWorktree: vi.fn(),
        revealWorktreeInSidebar: vi.fn(),
        setIsFullScreen: vi.fn(),
        updateBrowserTabPageState: vi.fn(),
        activeTabType: 'browser',
        editorFontZoomLevel: 0,
        setEditorFontZoomLevel: vi.fn(),
        setRateLimitsFromPush: vi.fn(),
        setSshConnectionState: vi.fn(),
        setSshTargetLabels: vi.fn(),
        setPortForwards: vi.fn(),
        clearPortForwards: vi.fn(),
        setDetectedPorts: vi.fn(),
        enqueueSshCredentialRequest: vi.fn(),
        removeSshCredentialRequest: vi.fn(),
        settings: { activeRuntimeEnvironmentId: null, terminalFontSize: 13 },
        activeBrowserTabId: 'workspace-1',
        activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-1' },
        browserTabsByWorktree: { 'wt-1': [{ id: 'workspace-1' }] },
        browserPagesByWorkspace: {},
        openFiles: [],
        unifiedTabsByWorktree: {},
        closeBrowserTab: vi.fn(),
        closeBrowserPage: vi.fn(),
        requestPinnedTabCloseConfirm: vi.fn(),
        ...getState()
      })
    }
  }

  vi.doMock('../store', () => appStoreModule)
  vi.doMock('@/store', () => appStoreModule)

  vi.doMock('@/lib/ui-zoom', () => ({
    applyUIZoom: vi.fn()
  }))
  vi.doMock('@/lib/worktree-activation', () => ({
    activateAndRevealWorktree: vi.fn(),
    ensureWorktreeHasInitialTerminal: vi.fn()
  }))
  vi.doMock('@/components/sidebar/visible-worktrees', () => ({
    getVisibleWorktreeIds: () => []
  }))
  vi.doMock('@/lib/editor-font-zoom', () => ({
    nextEditorFontZoomLevel: vi.fn(() => 0),
    computeEditorFontSize: vi.fn(() => 13)
  }))
  vi.doMock('@/components/settings/SettingsConstants', () => ({
    zoomLevelToPercent: vi.fn(() => 100),
    ZOOM_MIN: -3,
    ZOOM_MAX: 3
  }))
  vi.doMock('@/lib/zoom-events', () => ({
    dispatchZoomLevelChanged: vi.fn()
  }))

  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    api: {
      repos: { onChanged: () => () => {} },
      automations: { onChanged: () => () => {} },
      worktrees: {
        onChanged: () => () => {},
        onBaseStatus: () => () => {},
        onRemoteBranchConflict: () => () => {}
      },
      ui: {
        onStateChanged: () => () => {},
        onOpenSettings: () => () => {},
        consumePendingOpenSettings: () => Promise.resolve(false),
        onOpenFeatureTour: () => () => {},
        onToggleLeftSidebar: () => () => {},
        onToggleRightSidebar: () => () => {},
        onToggleWorktreePalette: () => () => {},
        onToggleFloatingTerminal: () => () => {},
        onOpenQuickOpen: () => () => {},
        onToggleQuickCommandsMenu: () => () => {},
        onOpenNewWorkspace: () => () => {},
        onOpenTasks: () => () => {},
        onJumpToWorktreeIndex: () => () => {},
        onJumpToTabIndex: () => () => {},
        onWorktreeHistoryNavigate: () => () => {},
        onActivateWorktree: () => () => {},
        onFocusTerminal: () => () => {},
        onFocusEditorTab: () => () => {},
        onSleepWorktree: () => () => {},
        onResumeSleepingAgents: () => () => {},
        onNewBrowserTab: () => () => {},
        onNewMarkdownTab: () => () => {},
        onRequestTabSetProfile: () => () => {},
        replyTabSetProfile: () => {},
        onNewTerminalTab: () => () => {},
        onCloseActiveTab: (listener: CloseActiveTabListener) => {
          if (closeActiveTabListenerRef) {
            closeActiveTabListenerRef.current = listener
          }
          return () => {}
        },
        onCloseFloatingItem: (listener: CloseFloatingItemListener) => {
          if (closeFloatingItemListenerRef) {
            closeFloatingItemListenerRef.current = listener
          }
          return () => {}
        },
        onSelectFloatingIndex: (listener: SelectFloatingIndexListener) => {
          if (selectFloatingIndexListenerRef) {
            selectFloatingIndexListenerRef.current = listener
          }
          return () => {}
        },
        onSwitchTab: () => () => {},
        onSwitchTabAcrossAllTypes: () => () => {},
        onSwitchRecentTab: () => () => {},
        onSwitchTerminalTab: () => () => {},
        onToggleStatusBar: () => () => {},
        onFullscreenChanged: () => () => {},
        onTerminalZoom: () => () => {},
        getZoomLevel: () => 0,
        set: vi.fn()
      },
      settings: {
        onChanged: () => () => {}
      },
      updater: {
        getStatus: () => Promise.resolve({ state: 'idle' }),
        onStatus: () => () => {},
        onClearDismissal: () => () => {}
      },
      browser: {
        onGuestLoadFailed: () => () => {},
        onOpenLinkInOrcaTab: () => () => {},
        onNavigationUpdate: () => () => {},
        onActivateView: () => () => {},
        onPaneFocus: () => () => {}
      },
      rateLimits: {
        get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
        onUpdate: () => () => {}
      },
      ssh: {
        listTargets: () => Promise.resolve([]),
        listPortForwards: () => Promise.resolve([]),
        listDetectedPorts: () => Promise.resolve([]),
        getState: () => Promise.resolve(null),
        onStateChanged: () => () => {},
        onCredentialRequest: () => () => {},
        onPortForwardsChanged: () => () => {},
        onDetectedPortsChanged: () => () => {},
        onCredentialResolved: () => () => {}
      },
      runtime: {
        getTerminalFitOverrides: () => Promise.resolve([]),
        getTerminalDrivers: () => Promise.resolve([]),
        getBrowserDrivers: () => Promise.resolve([]),
        onTerminalFitOverrideChanged: () => () => {},
        onTerminalDriverChanged: () => () => {},
        onBrowserDriverChanged: () => {},
        onClientHostedBrowserRowsChanged: () => {},
        getClientHostedBrowserRows: async () => []
      },
      agentStatus: { onSet: () => () => {} }
    }
  })

  const { useIpcEvents: registerIpcEvents } = await import('./useIpcEvents')
  registerIpcEvents()
}
