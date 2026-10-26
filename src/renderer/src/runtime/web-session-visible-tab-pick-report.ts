import {
  CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX,
  type RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { useAppStore } from '../store'
import { getRuntimeEnvironmentConnectionGeneration } from '../store/slices/runtime-status-connection-generation'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'
import {
  peekWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from './web-session-focus-intent'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'
import { isServerFrameDrawnWorkspace } from './web-session-tabs-sync/frame-drawn-server-workspaces'

/** The pane last reported per connection and workspace. Reporting again only when the desktop's own
 *  pane changes keeps two windows sharing one device id from steering the pick back and forth. */
const reportedPaneByWorkspace = new Map<string, string>()

/**
 * The server remembers each device's tab per workspace and hands it back whenever the desktop has
 * no tab groups of its own for that workspace (first open, or a saved session that lost them). A
 * desktop that kept its own groups never told the server what it showed, so that memory went stale
 * and such an open landed on the wrong tab. Report the visible terminal pane when they differ.
 */
export function reportVisibleTabPickToHost(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  // Only servers that keep a pick per device project it; an older one would move the host instead.
  if (!snapshot.publicationEpoch.endsWith(CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX)) {
    return
  }
  const worktreeId = snapshot.worktree
  const owner = captureWebSessionIntentOwner(environmentId)
  if (
    !isWebRuntimeSessionActive(environmentId) ||
    isServerFrameDrawnWorkspace(environmentId, worktreeId) ||
    peekWebSessionFocusIntent(owner, worktreeId)
  ) {
    return
  }
  const state = useAppStore.getState()
  // Without groups of its own the desktop shows the server's pick; there is nothing to report.
  if ((state.groupsByWorktree[worktreeId] ?? []).length === 0) {
    return
  }
  const visibleId = resolveWebSessionVisibleTabId(state, worktreeId)
  const visible = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === visibleId)
  if (visible?.contentType !== 'terminal' || !isWebTerminalSurfaceTabId(visible.entityId)) {
    return
  }
  const hostTabId = toHostSessionTabId(visible.entityId)
  const picked = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)
  const pickedHostTabId = picked?.type === 'terminal' ? picked.parentTabId : picked?.id
  if (pickedHostTabId === hostTabId) {
    return
  }
  // Name the exact pane and require it ready: activating a pending one would start its terminal.
  const localLeafId = state.terminalLayoutsByTabId[visible.entityId]?.activeLeafId
  const target = snapshot.tabs.find(
    (tab) =>
      tab.type === 'terminal' &&
      tab.parentTabId === hostTabId &&
      (!localLeafId || tab.leafId === localLeafId)
  )
  if (target?.type !== 'terminal' || target.status !== 'ready') {
    return
  }
  const key = [
    environmentId,
    owner.pairingRevision,
    getRuntimeEnvironmentConnectionGeneration(environmentId),
    worktreeId
  ].join('\0')
  const pane = `${hostTabId}\0${target.leafId}`
  if (reportedPaneByWorkspace.get(key) === pane) {
    return
  }
  reportedPaneByWorkspace.set(key, pane)
  const retryLater = (): void => {
    if (reportedPaneByWorkspace.get(key) === pane) {
      reportedPaneByWorkspace.delete(key)
    }
  }
  void captureRuntimeEnvironmentCall(
    environmentId,
    owner.pairingRevision
  )({
    method: 'session.tabs.activate',
    params: {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      tabId: hostTabId,
      leafId: target.leafId,
      notifyClients: false,
      navigation: 'caller',
      intent: 'automatic'
    },
    timeoutMs: WEB_SESSION_TAB_RPC_TIMEOUT_MS
  }).then(
    // Best effort; a failed report is tried again on a later frame.
    (response) => {
      if (!response.ok) {
        retryLater()
      }
    },
    retryLater
  )
}

export function resetReportedVisibleTabPicksForTests(): void {
  reportedPaneByWorkspace.clear()
}
