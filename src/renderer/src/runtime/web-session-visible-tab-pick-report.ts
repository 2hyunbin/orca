import {
  CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX,
  type RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { useAppStore } from '../store'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'
import { peekWebSessionFocusIntent } from './web-session-focus-intent'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'
import { isServerFrameDrawnWorkspace } from './web-session-tabs-sync/frame-drawn-server-workspaces'

/** Last pick reported per environment and workspace, so one divergence costs one RPC. */
const reportedPickByWorkspace = new Map<string, string>()

/**
 * The server remembers each device's tab per workspace and hands it back whenever the desktop has
 * no tab groups of its own for that workspace (first open, or a saved session that lost them). A
 * desktop that kept its own groups never tells the server what it shows, so that memory went stale
 * and such an open landed on the wrong tab. Report the visible terminal tab when they differ.
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
  if (
    !isWebRuntimeSessionActive(environmentId) ||
    isServerFrameDrawnWorkspace(environmentId, worktreeId) ||
    peekWebSessionFocusIntent(captureWebSessionIntentOwner(environmentId), worktreeId)
  ) {
    return
  }
  const state = useAppStore.getState()
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const activeTabId = state.groupsByWorktree[worktreeId]?.find(
    (group) => group.id === activeGroupId
  )?.activeTabId
  const visible = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === activeTabId)
  if (visible?.contentType !== 'terminal' || !isWebTerminalSurfaceTabId(visible.entityId)) {
    return
  }
  const hostTabId = toHostSessionTabId(visible.entityId)
  const picked = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)
  const pickedHostTabId = picked?.type === 'terminal' ? picked.parentTabId : picked?.id
  const key = `${environmentId}\0${worktreeId}`
  if (pickedHostTabId === hostTabId) {
    reportedPickByWorkspace.delete(key)
    return
  }
  // Name the exact pane and require it ready: activating a pending one would start its terminal.
  const localLeafId = state.terminalLayoutsByTabId[visible.entityId]?.activeLeafId
  const target =
    snapshot.tabs.find(
      (tab) =>
        tab.type === 'terminal' &&
        tab.parentTabId === hostTabId &&
        (!localLeafId || tab.leafId === localLeafId)
    ) ?? null
  if (
    target?.type !== 'terminal' ||
    target.status !== 'ready' ||
    reportedPickByWorkspace.get(key) === hostTabId
  ) {
    return
  }
  reportedPickByWorkspace.set(key, hostTabId)
  const retryLater = (): void => {
    if (reportedPickByWorkspace.get(key) === hostTabId) {
      reportedPickByWorkspace.delete(key)
    }
  }
  void captureRuntimeEnvironmentCall(environmentId)({
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
    // Best effort; a later frame that still differs reports again.
    (response) => {
      if (!response.ok) {
        retryLater()
      }
    },
    retryLater
  )
}

export function resetReportedVisibleTabPicksForTests(): void {
  reportedPickByWorkspace.clear()
}
