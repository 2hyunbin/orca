import {
  CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX,
  type RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { useAppStore } from '../store'
import { getRuntimeEnvironmentConnectionGeneration } from '../store/slices/runtime-status-connection-generation'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../lib/worktree-runtime-owner'
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
/** Each workspace's latest frame, so opening a workspace can report without waiting for a new one. */
const latestFrameByWorkspace = new Map<
  string,
  { environmentId: string; snapshot: RuntimeMobileSessionTabsResult }
>()
const pendingCheckByWorkspace = new Map<string, ReturnType<typeof setTimeout>>()
let stopWatchingActiveWorkspace: (() => void) | null = null

/** A tab click records its activation only after an async hop; settle before comparing so a
 *  report can never race the user's own pick to the server. */
export const VISIBLE_TAB_PICK_SETTLE_MS = 1500

function scheduleCheck(frameKey: string): void {
  clearTimeout(pendingCheckByWorkspace.get(frameKey))
  pendingCheckByWorkspace.set(
    frameKey,
    setTimeout(() => {
      pendingCheckByWorkspace.delete(frameKey)
      const frame = latestFrameByWorkspace.get(frameKey)
      if (frame) {
        reportIfStale(frame.environmentId, frame.snapshot)
      }
    }, VISIBLE_TAB_PICK_SETTLE_MS)
  )
}

function watchActiveWorkspace(): void {
  stopWatchingActiveWorkspace ??= useAppStore.subscribe((state, previous) => {
    if (!state.activeWorktreeId || state.activeWorktreeId === previous.activeWorktreeId) {
      return
    }
    for (const [frameKey, frame] of latestFrameByWorkspace) {
      if (frame.snapshot.worktree === state.activeWorktreeId) {
        scheduleCheck(frameKey)
      }
    }
  })
}

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
  const frameKey = `${environmentId}\0${snapshot.worktree}`
  latestFrameByWorkspace.set(frameKey, { environmentId, snapshot })
  watchActiveWorkspace()
  scheduleCheck(frameKey)
}

function reportIfStale(environmentId: string, snapshot: RuntimeMobileSessionTabsResult): void {
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
  // Only the workspace on screen: its pane attaches anyway, so a report can never start a terminal
  // the user isn't looking at. Without groups of its own the desktop shows the server's pick.
  if (
    state.activeWorktreeId !== worktreeId ||
    // Two paired servers can publish the same workspace id; only its owner hears about it.
    runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId) !== environmentId ||
    (state.groupsByWorktree[worktreeId] ?? []).length === 0
  ) {
    return
  }
  const visibleId = resolveWebSessionVisibleTabId(state, worktreeId)
  const visible = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === visibleId)
  if (visible?.contentType !== 'terminal' || !isWebTerminalSurfaceTabId(visible.entityId)) {
    return
  }
  const hostTabId = toHostSessionTabId(visible.entityId)
  // Name the exact pane: the server remembers a pane, not just a tab.
  const localLeafId = state.terminalLayoutsByTabId[visible.entityId]?.activeLeafId
  const target = snapshot.tabs.find(
    (tab) =>
      tab.type === 'terminal' &&
      tab.parentTabId === hostTabId &&
      (!localLeafId || tab.leafId === localLeafId)
  )
  if (target?.type !== 'terminal') {
    return
  }
  const key = [
    environmentId,
    owner.pairingRevision,
    getRuntimeEnvironmentConnectionGeneration(environmentId),
    worktreeId
  ].join('\0')
  const pane = `${hostTabId}\0${target.leafId}`
  if (snapshot.activeTabId === target.id) {
    // In agreement: remember it, so a later change of this desktop's pane reports again.
    reportedPaneByWorkspace.set(key, pane)
    return
  }
  // A pending pane would be started by activation; its own attach handles that.
  if (target.status !== 'ready' || reportedPaneByWorkspace.get(key) === pane) {
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
  latestFrameByWorkspace.clear()
  for (const timer of pendingCheckByWorkspace.values()) {
    clearTimeout(timer)
  }
  pendingCheckByWorkspace.clear()
  stopWatchingActiveWorkspace?.()
  stopWatchingActiveWorkspace = null
}
