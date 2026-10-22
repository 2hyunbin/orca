import { vi } from 'vitest'
import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { retireManagedPanePreservingPty } from '@/lib/pane-manager/pane-split-close'
import { createTerminalPaneClosedHandler } from './terminal-pane-pane-closed'
import { registerTerminalPaneMount } from './terminal-pane-mount-registration'
import { cleanupTerminalPaneMount } from './terminal-pane-mount-cleanup'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'
import type { PaneClosedHandlerContext } from './terminal-pane-mount-context'
import { useAppStore } from '@/store'

export const LEAF = '11111111-1111-4111-8111-111111111111'
export const SIBLING = '22222222-2222-4222-8222-222222222222'

function pane(id: number, leafId: string): ManagedPaneInternal {
  const terminal = {
    dispose: vi.fn(),
    clearSelection: vi.fn(),
    focus: vi.fn(),
    buffer: { active: { type: 'normal', viewportY: 0, baseY: 0 } }
  }
  const addon = () => ({ dispose: vi.fn() })
  const container = document.createElement('div')
  container.classList.add('pane')
  container.dataset.leafId = leafId
  // SAFETY: real disposal reads only the listed terminal/addon lifecycle and optional resources.
  return {
    id,
    leafId,
    stablePaneId: leafId,
    terminal,
    container,
    searchAddon: addon(),
    serializeAddon: addon(),
    unicode11Addon: addon(),
    webLinksAddon: addon(),
    fitAddon: addon(),
    webglAddon: null,
    imageAddon: null,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    paneDragCleanup: vi.fn(),
    focusClassSyncCleanup: vi.fn()
  } as unknown as ManagedPaneInternal
}

/** Uses the production tree teardown, real pane disposer and real mount closure callback. */
export function mountedOwner(
  split: boolean,
  address = {
    tabId: 'terminal',
    worktreeId: 'wt-1',
    leafId: LEAF,
    ptyId: 'pty-1'
  }
) {
  const source = pane(1, address.leafId)
  const other = pane(2, SIBLING)
  const panes = new Map([[1, source], ...(split ? [[2, other] as const] : [])])
  const sourceTransport = { getPtyId: () => address.ptyId, detach: vi.fn(), destroy: vi.fn() }
  const transports = new Map([[1, sourceTransport]])
  const binding = { dispose: vi.fn() }
  const bindings = new Map([[1, binding]])
  const ref = () => ({ current: new Map() })
  const refs = Object.fromEntries(
    [
      'linkProviderDisposablesRef',
      'terminalHandleLinkDisposablesRef',
      'linkifierClickPrimingDisposablesRef',
      'linkPointerGesturesRef',
      'fileLinkClickFallbackDisposablesRef',
      'httpLinkClickFallbackDisposablesRef',
      'selectionDisposablesRef',
      'nativeCopyDisposablesRef',
      'imeCompositionDisposablesRef',
      'imeNativeTextForwarderDisposablesRef',
      'selectionCaptureTimersRef',
      'osc52DisposablesRef',
      'osc7DisposablesRef',
      'mouseHideDisposablesRef',
      'restoredViewportBlankingPanesRef'
    ].map((name) => [name, ref()])
  )
  const link = { dispose: vi.fn() }
  refs.linkProviderDisposablesRef.current.set(1, link)
  const state = useAppStore.getState()
  let manager: PaneManager
  const managerRef: { current: PaneManager | null } = { current: null }
  const deps = {
    tabId: address.tabId,
    worktreeId: address.worktreeId,
    managerRef,
    containerRef: { current: null },
    paneTransportsRef: { current: transports },
    panePtyBindingsRef: { current: bindings },
    paneMode2031Ref: ref(),
    paneKittyKeyboardModesRef: ref(),
    paneLastThemeModeRef: ref(),
    paneCwdRef: ref(),
    paneFontSizesRef: ref(),
    replayingPanesRef: ref(),
    clearRuntimePaneTitle: state.clearRuntimePaneTitle,
    syncPanePtyLayoutBinding: vi.fn(),
    clearTabPtyId: state.clearTabPtyId,
    setPaneTitles: vi.fn(),
    paneTitlesRef: { current: {} },
    setRenamingPaneId: vi.fn(),
    setPaneCount: vi.fn(),
    setTabPaneExpanded: state.setTabPaneExpanded,
    setTabCanExpandPane: state.setTabCanExpandPane,
    updateTabTitle: state.updateTabTitle,
    persistLayoutSnapshot: vi.fn(),
    getTabWideAgentHintLeafId: () => null
  }
  // SAFETY: this fixture exercises only registration and the concrete closure handler, using their dependencies above.
  const context = {
    deps,
    refs,
    deferredSplitHandoffs: new Map(),
    getOwnedManager: () => manager
  } as unknown as Pick<
    PaneClosedHandlerContext,
    'deps' | 'refs' | 'deferredSplitHandoffs' | 'getOwnedManager'
  >
  const onPaneClosed = createTerminalPaneClosedHandler(context)
  const onLayoutChanged = vi.fn()
  // SAFETY: the mount's manager adapter delegates its permanent removal to the production mutation/disposer.
  manager = {
    getPanes: () => [...panes.values()],
    getActivePane: () => panes.get(2) ?? panes.get(1) ?? null,
    retirePanePreservingPty: (id: number, permanent: boolean) =>
      retireManagedPanePreservingPty(
        {
          paneId: id,
          activePaneId: 1,
          panes,
          root: document.createElement('div'),
          styleOptions: {},
          managerOptions: { linkOpenHint: () => '', onPaneClosed, onLayoutChanged },
          getDragCallbacks: () => ({
            getPanes: () => panes,
            getRoot: () => source.container,
            getStyleOptions: () => ({}),
            isDestroyed: () => false,
            safeFit: vi.fn(),
            applyPaneOpacity: vi.fn(),
            applyDividerStyles: vi.fn(),
            refitPanesUnder: vi.fn()
          }),
          releasePaneIdentity: vi.fn(),
          setActivePaneId: vi.fn()
        },
        permanent
      ),
    destroy: vi.fn()
  } as unknown as PaneManager
  managerRef.current = manager
  const cancelResize = vi.fn()
  const expandedElement = document.createElement('div')
  expandedElement.style.display = 'none'
  const expandedStyleSnapshots = new Map([[expandedElement, { display: 'flex', flex: '1' }]])
  const removeMountEvents = installTerminalPaneMountEvents({
    manager,
    deps: {
      ...deps,
      isActive: false,
      showPaneTitle: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn()
    },
    // SAFETY: event installation only captures these dependencies; no split command is issued.
    ptyDeps: {} as Parameters<typeof installTerminalPaneMountEvents>[0]['ptyDeps']
  })
  const empty = vi.fn(() => {
    removeMountEvents()
    cleanupTerminalPaneMount({
      manager,
      deps: context.deps,
      refs: context.refs,
      deferredSplitHandoffs: context.deferredSplitHandoffs,
      expandedStyleSnapshots,
      unregisterRuntimeTab: registration.unregisterRuntimeTab,
      cancelResize,
      permanent: true
    })
  })
  const registration = registerTerminalPaneMount(context, empty)
  registration.setOwnedManager(manager)
  // A null rendering ref does not release the actual mounted owner.
  managerRef.current = null
  return {
    source,
    other,
    panes,
    sourceTransport,
    transports,
    binding,
    bindings,
    link,
    onLayoutChanged,
    manager,
    empty,
    cancelResize,
    expandedElement,
    setPaneCount: deps.setPaneCount,
    unregister: () => {
      removeMountEvents()
      registration.unregisterRuntimeTab()
    }
  }
}
