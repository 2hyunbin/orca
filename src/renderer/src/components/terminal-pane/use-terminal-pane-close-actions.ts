import type {
  RequestActiveTerminalPaneCloseDetail,
  TerminalPaneCloseCallbacks
} from '@/constants/terminal'
import { useTerminalPaneCloseRequest } from './use-terminal-pane-close-request'
import { useCallback, useEffect, useRef } from 'react'
import { onActiveTerminalPaneCloseRequest } from './request-active-terminal-pane-close'
import { useAppStore } from '../../store'
import { retireUnboundRuntimeTerminalPane } from './retire-unbound-runtime-terminal-pane'
import type { PaneExternalDropTarget } from '@/lib/pane-manager/pane-manager'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { closeWebRuntimeTerminal } from '@/runtime/web-runtime-terminal-actions'
import {
  detachTerminalPaneToTab,
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget
} from './terminal-pane-tab-detach'
import { clearPaneTerminalError } from './terminal-error-accumulation'
import type { TerminalPaneBindingController } from './use-terminal-pane-layout-bindings'
import { retireUnboundIpcTerminalPane } from './retire-unbound-ipc-terminal-pane'
import { capturePendingTerminalPaneClose } from './terminal-pane-close-admission'
import { commitTerminalSurfaceClose } from '@/store/terminals/terminal-surface-close-intent'
import { noteAgentLaunchPaneClosedByUser } from '@/lib/agent-launch-pane-closes'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { sendUserPaneCloseToLayoutOwner } from './layout-owner-pane-close-command'

export function useTerminalPaneCloseActions(controller: TerminalPaneBindingController) {
  const cancelCloseRef = useRef<(() => void) | undefined>(undefined)
  const confirmedCloseRef = useRef<(() => void) | null>(null)
  const {
    clearSessionRestoredBannerForPane,
    managerRef,
    onCloseTab,
    paneCwdRef,
    paneTransportsRef,
    pendingCloseConfirmation,
    persistLayoutSnapshot,
    setPendingCloseConfirmation,
    setTerminalErrorsByPaneId,
    syncPanePtyLayoutBinding,
    syncPanePtyLayoutBindingForLeaf,
    tabId,
    updateSettings,
    worktreeId
  } = controller
  // The window's half of a split pane's close: its transport, status and pane go.
  const closePaneLocally = useCallback(
    (paneId: number, committedLeafId?: string) => {
      const manager = managerRef.current
      // Why the pane check: main's answer can land after the pane already went.
      if (!manager || (committedLeafId && manager.getLeafId(paneId) !== committedLeafId)) {
        return
      }
      // A sibling went while main answered: this pane is now the tab's last, so the tab closes.
      if (committedLeafId && manager.getPanes().length <= 1) {
        onCloseTab()
        return
      }
      const ptyId = paneTransportsRef.current.get(paneId)?.getPtyId() ?? null
      closeWebRuntimeTerminal(ptyId, worktreeId)
      clearSessionRestoredBannerForPane(paneId)
      const leafId = manager.getLeafId(paneId)
      if (leafId) {
        const launchPane = useAppStore
          .getState()
          .tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.agentLaunchPane
        if (launchPane?.leafId === leafId && !launchPane.outcome) {
          // The user closed a launch pane whose agent is still starting; main stops that launch.
          noteAgentLaunchPaneClosedByUser(tabId, leafId)
        }
        if (!committedLeafId) {
          commitTerminalSurfaceClose(worktreeId, { kind: 'pane', tabId, leafId })
        }
        retireUnboundIpcTerminalPane({
          getState: useAppStore.getState,
          tabId,
          leafId,
          transport: paneTransportsRef.current.get(paneId),
          getTransports: () => paneTransportsRef.current
        })
        useAppStore.getState().setCacheTimerStartedAt(makePaneKey(tabId, leafId), null)
        useAppStore.getState().dropAgentStatus(makePaneKey(tabId, leafId), { paneRemoved: true })
      }
      setTerminalErrorsByPaneId((current) => clearPaneTerminalError(current, paneId))
      if (leafId) {
        retireUnboundRuntimeTerminalPane({
          getState: useAppStore.getState,
          tabId,
          leafId,
          transport: paneTransportsRef.current.get(paneId),
          getTransports: () => paneTransportsRef.current
        })
        syncPanePtyLayoutBindingForLeaf?.(leafId, null, paneId)
      } else {
        syncPanePtyLayoutBinding(paneId, null)
      }
      manager.closePane(paneId)
    },
    [
      clearSessionRestoredBannerForPane,
      onCloseTab,
      syncPanePtyLayoutBinding,
      syncPanePtyLayoutBindingForLeaf,
      tabId,
      worktreeId,
      managerRef,
      paneTransportsRef,
      setTerminalErrorsByPaneId
    ]
  )
  const executeClosePane = useCallback(
    (paneId: number, callbacks?: TerminalPaneCloseCallbacks) => {
      const manager = managerRef.current
      if (!manager || callbacks?.isCurrent?.() === false) {
        callbacks?.onCancel?.()
        return
      }
      if (manager.getPanes().length <= 1) {
        onCloseTab(
          callbacks?.onConfirm
            ? {
                ...callbacks,
                onConfirm: (force) => {
                  cancelCloseRef.current = undefined
                  callbacks.onConfirm?.(force)
                }
              }
            : callbacks
        )
        return
      }
      if (callbacks?.onConfirm) {
        cancelCloseRef.current = undefined
        callbacks.onConfirm()
        return
      }
      const leafId = manager.getLeafId(paneId)
      if (!leafId) {
        callbacks?.onCancel?.()
        return
      }
      // Switch point: main closes the pane first; the window removes it when main's frame does.
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        sendUserPaneCloseToLayoutOwner(
          { worktreeId, tabId, leafId, paneId },
          {
            getManager: () => managerRef.current,
            closeTab: onCloseTab,
            closePaneLocally
          }
        )
      ) {
        return
      }
      closePaneLocally(paneId)
    },
    [closePaneLocally, onCloseTab, tabId, worktreeId, managerRef]
  )
  const { requestClose, getCloseDialogCopyKind } = useTerminalPaneCloseRequest(
    controller,
    executeClosePane,
    cancelCloseRef,
    confirmedCloseRef
  )
  const handleRequestClosePane = useCallback(
    (paneId: number, callbacks?: TerminalPaneCloseCallbacks) => {
      cancelCloseRef.current?.()
      cancelCloseRef.current = undefined
      confirmedCloseRef.current = null
      if (callbacks?.signal?.aborted) {
        callbacks.onCancel?.()
        return
      }
      cancelCloseRef.current = callbacks?.onCancel
      if ((managerRef.current?.getPanes().length ?? 0) <= 1) {
        executeClosePane(paneId, callbacks)
        return
      }
      const transport = paneTransportsRef.current.get(paneId)
      const pending = capturePendingTerminalPaneClose(controller, paneId, useAppStore.getState)
      const ptyId = transport?.getPtyId() ?? pending?.ptyId
      if (!ptyId) {
        executeClosePane(paneId, callbacks)
        return
      }
      requestClose(paneId, ptyId, pending, callbacks)
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [executeClosePane, requestClose]
  )
  const closeActivePane = useCallback(
    (request: RequestActiveTerminalPaneCloseDetail): void => {
      const manager = managerRef.current
      const pane = request.leafId
        ? manager?.getPanes().find((p) => manager.getLeafId(p.id) === request.leafId)
        : (manager?.getActivePane() ?? manager?.getPanes()[0])
      if (pane) {
        handleRequestClosePane(pane.id, request)
      } else {
        request.onCancel?.()
      }
    },
    [handleRequestClosePane, managerRef]
  )
  useEffect(() => {
    const stop = onActiveTerminalPaneCloseRequest(tabId, closeActivePane)
    return () => {
      stop()
      cancelCloseRef.current?.()
      cancelCloseRef.current = undefined
      confirmedCloseRef.current = null
    }
  }, [closeActivePane, tabId])
  const handleSearchSelectedText = useCallback((selectedText: string): void => {
    useAppStore.getState().showRightSidebarSearch({ query: selectedText })
  }, [])
  const handleConfirmClose = useCallback(
    (dontAskAgain: boolean) => {
      if (pendingCloseConfirmation === null || confirmedCloseRef.current === null) {
        return
      }
      const confirmedClose = confirmedCloseRef.current
      confirmedCloseRef.current = null
      setPendingCloseConfirmation(null)
      if (dontAskAgain) {
        void updateSettings({
          skipCloseTerminalWithRunningProcessConfirm: true
        })
      }
      confirmedClose()
    },
    [pendingCloseConfirmation, updateSettings, setPendingCloseConfirmation]
  )
  const handleCancelClose = useCallback(() => {
    cancelCloseRef.current?.()
    cancelCloseRef.current = undefined
    confirmedCloseRef.current = null
    setPendingCloseConfirmation(null)
  }, [setPendingCloseConfirmation])
  const resolveExternalPaneDropTarget = useCallback(
    ({
      sourcePaneId,
      clientX,
      clientY
    }: {
      sourcePaneId: number
      clientX: number
      clientY: number
    }) => {
      const panes = managerRef.current?.getPanes() ?? []
      if (panes.length <= 1 || !panes.some((pane) => pane.id === sourcePaneId)) {
        return null
      }
      return resolveTerminalTabStripDropTarget({
        clientX,
        clientY,
        groupsByWorktree: useAppStore.getState().groupsByWorktree,
        worktreeId
      })
    },
    [worktreeId, managerRef]
  )
  const handleExternalPaneDrop = useCallback(
    (sourcePaneId: number, target: PaneExternalDropTarget): boolean => {
      if (!isTerminalTabStripDropTarget(target)) {
        return false
      }
      const sourceTransport = paneTransportsRef.current.get(sourcePaneId)
      const livePtyId = sourceTransport?.getPtyId() ?? null
      const sourcePaneCwd = paneCwdRef.current.get(sourcePaneId)
      void detachTerminalPaneToTab({
        livePtyId,
        getStore: useAppStore.getState,
        manager: managerRef.current,
        persistLayoutSnapshot,
        sourcePaneId,
        ...(sourcePaneCwd ? { sourcePaneCwd } : {}),
        sourceConnectPending: sourceTransport?.isConnectPending?.() ?? false,
        sourceTabId: tabId,
        targetGroupId: target.groupId,
        targetIndex: target.insertionIndex,
        worktreeId
      }).catch((error) => console.warn('[terminal-pane-detach] move failed', error))
      return true
    },
    [persistLayoutSnapshot, tabId, worktreeId, managerRef, paneCwdRef, paneTransportsRef]
  )

  return {
    closePaneLocally,
    executeClosePane,
    getCloseDialogCopyKind,
    handleRequestClosePane,
    handleSearchSelectedText,
    handleConfirmClose,
    handleCancelClose,
    resolveExternalPaneDropTarget,
    handleExternalPaneDrop
  }
}

export type TerminalPaneCloseController = TerminalPaneBindingController &
  ReturnType<typeof useTerminalPaneCloseActions>
