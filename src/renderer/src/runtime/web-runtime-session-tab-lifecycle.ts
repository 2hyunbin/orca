import type { RuntimeSessionTabCloseReason } from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  rereadHostSessionTabs,
  settleHostSessionTabClose,
  type HostSessionTabCloseResult
} from './host-session-tab-close'
import {
  beginWebSessionCloseIntent,
  type WebSessionCloseIntentTicket
} from './web-session-close-intent'
import {
  clearWebSessionFocusIntent,
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent
} from './web-session-focus-intent'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { resolveHostSessionTabIdForWebSessionTab } from './web-session-tabs-sync/tracking-mappings'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'

function resolveSessionTabEnvironmentId(environmentId: string | null | undefined): string | null {
  const resolved =
    environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  return resolved && isWebRuntimeSessionActive(resolved) ? resolved : null
}

async function resolveHostTabId(
  environmentId: string,
  worktreeId: string,
  tabId: string
): Promise<string> {
  const { resolveHostSessionTabIdForWebSessionTab } =
    await import('./web-session-tabs-sync/tracking-mappings')
  return (
    resolveHostSessionTabIdForWebSessionTab(useAppStore.getState(), {
      environmentId,
      worktreeId,
      tabId
    }) ?? toHostSessionTabId(tabId)
  )
}

export async function activateWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
  /** The split pane the user picked; without it the host and focus intent pick the first. */
  leafId?: string | null
  /** The local tab visible at the gesture; later navigation away cancels the deferred focus. */
  expectedCurrentLocalTabId?: string | null
}): Promise<boolean> {
  const environmentId = resolveSessionTabEnvironmentId(args.environmentId)
  const intentOwner = environmentId ? captureWebSessionIntentOwner(environmentId) : null
  const callEnvironment =
    environmentId && intentOwner
      ? captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)
      : null
  // COMPAT(legacy-relay-bridge, revisit 2027-01-15): an older relay runs a pane in this tab, and
  // activating that pane on the managed server would start a second shell there that no tab shows.
  // A click names no leaf, so the pane on screen does; the server would otherwise pick the first.
  // Loaded lazily: the module subscribes to main's pane list on import, and terminal panes load it.
  const { hasLegacyRelayBridgedPane, isLegacyRelayBridgedTab } =
    await import('../components/terminal-pane/legacy-relay-bridge-panes')
  const leafId =
    args.leafId ??
    (hasLegacyRelayBridgedPane(args.tabId)
      ? useAppStore.getState().terminalLayoutsByTabId?.[args.tabId]?.activeLeafId
      : null)
  if (isLegacyRelayBridgedTab(args.tabId, leafId)) {
    // This gesture still supersedes an earlier tab's pending focus, as recording its own would.
    if (intentOwner) {
      clearWebSessionFocusIntent(intentOwner, args.worktreeId)
    }
    return true
  }
  if (!intentOwner || !callEnvironment || !environmentId) {
    return false
  }
  let hostTabId: string | null = null
  try {
    hostTabId = await resolveHostTabId(environmentId, args.worktreeId, args.tabId)
    recordWebSessionFocusIntent(
      intentOwner,
      args.worktreeId,
      hostTabId,
      leafId ?? undefined,
      args.expectedCurrentLocalTabId
    )
    const response = await callEnvironment({
      method: 'session.tabs.activate',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId,
        ...(leafId ? { leafId } : {}),
        // Why: the additive navigation target protects new hosts while notifyClients:false protects old hosts.
        notifyClients: false,
        navigation: 'caller' as const,
        // Why: every caller here is a tab click, shortcut, or palette pick —
        // the gesture that is supposed to wake a slept pane.
        intent: 'user' as const
      },
      timeoutMs: WEB_SESSION_TAB_RPC_TIMEOUT_MS
    })
    unwrapRuntimeRpcResult(response)
    return true
  } catch (error) {
    if (hostTabId) {
      clearWebSessionFocusIntentIfMatches(intentOwner, args.worktreeId, hostTabId)
    }
    console.warn(
      '[web-runtime-session] failed to activate tab:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export type WebRuntimeSessionTabCloseOutcome = HostSessionTabCloseResult

export async function closeWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
  reason: RuntimeSessionTabCloseReason
  publicationEpoch?: string | null
  terminalHandle?: string | null
  initialCloseTicket?: WebSessionCloseIntentTicket | null
}): Promise<WebRuntimeSessionTabCloseOutcome> {
  const environmentId =
    args.initialCloseTicket?.owner.environmentId ??
    resolveSessionTabEnvironmentId(args.environmentId)
  if (!environmentId) {
    return 'failed'
  }
  const intentOwner = args.initialCloseTicket?.owner ?? captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)
  const reread = (acceptCurrent: boolean): Promise<void> =>
    rereadHostSessionTabs(
      { kind: 'environment', environmentId },
      args.worktreeId,
      intentOwner.pairingRevision,
      acceptCurrent
    )
  const isLifecycleClose = args.reason !== 'user'
  if (isLifecycleClose && (!args.publicationEpoch || !args.terminalHandle)) {
    // Why: missing host-generation or terminal-incarnation evidence means keep;
    // a tab id alone can be stale or reused after reconnect.
    await reread(true)
    console.warn('[web-runtime-session] suppressed lifecycle close without incarnation evidence', {
      closeReason: args.reason
    })
    return 'failed'
  }

  // Capture aliases before local pruning can discard their host correspondence.
  const hostTabId =
    args.initialCloseTicket?.closedId ??
    resolveHostSessionTabIdForWebSessionTab(useAppStore.getState(), {
      environmentId,
      worktreeId: args.worktreeId,
      tabId: args.tabId
    }) ??
    toHostSessionTabId(args.tabId)
  const tickets: WebSessionCloseIntentTicket[] = []
  if (args.initialCloseTicket) {
    tickets.push(args.initialCloseTicket)
  } else {
    for (const closedId of new Set([toHostSessionTabId(args.tabId), hostTabId])) {
      const ticket = beginWebSessionCloseIntent(intentOwner, args.worktreeId, closedId, Date.now())
      if (ticket) {
        tickets.push(ticket)
      }
    }
  }
  const close = (async () => {
    const response = await callEnvironment({
      // Why: old hosts cannot route this additive method, so a generation
      // cutover fails closed before their destructive legacy close handler.
      method: isLifecycleClose ? 'session.tabs.closeLifecycle' : 'session.tabs.close',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId,
        reason: args.reason,
        ...(isLifecycleClose
          ? { publicationEpoch: args.publicationEpoch, terminal: args.terminalHandle }
          : {})
      },
      timeoutMs: WEB_SESSION_TAB_RPC_TIMEOUT_MS
    })
    return unwrapRuntimeRpcResult(response)
  })()
  return settleHostSessionTabClose({
    tickets: () => tickets,
    close,
    reread,
    // Why: a paired host's lists travel apart from its answer, so read once after the close.
    readAfterClose: true
  })
}
