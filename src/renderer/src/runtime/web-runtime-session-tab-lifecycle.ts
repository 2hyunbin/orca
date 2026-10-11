import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTabCloseResult,
  RuntimeSessionTabCloseReason
} from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { settleHostSessionTabClose, type HostSessionTabCloseResult } from './host-session-tab-close'
import { beginWebSessionTabClose, type WebSessionTabCloseTicket } from './web-session-close-intent'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent
} from './web-session-focus-intent'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'
import { toHostSessionTabId } from './web-terminal-surface-id'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'

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
  const { resolveHostSessionTabIdForWebSessionTab } = await import('./web-session-tabs-sync')
  return (
    resolveHostSessionTabIdForWebSessionTab(useAppStore.getState(), {
      environmentId,
      worktreeId,
      tabId
    }) ?? toHostSessionTabId(tabId)
  )
}

async function rereadAcceptingCurrent(
  environmentId: string,
  worktreeId: string,
  expectedEnvironmentPairingRevision: number | undefined
): Promise<void> {
  const { acceptReplayedWebSessionTabsSnapshot } = await import('./web-session-tabs-sync')
  acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
  await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, {
    expectedEnvironmentPairingRevision
  })
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
  if (!environmentId) {
    return false
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)
  let hostTabId: string | null = null
  try {
    hostTabId = await resolveHostTabId(environmentId, args.worktreeId, args.tabId)
    recordWebSessionFocusIntent(
      intentOwner,
      args.worktreeId,
      hostTabId,
      args.leafId ?? undefined,
      args.expectedCurrentLocalTabId
    )
    const response = await callEnvironment({
      method: 'session.tabs.activate',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId,
        ...(args.leafId ? { leafId: args.leafId } : {}),
        // Why: the additive navigation target protects new hosts while notifyClients:false protects old hosts.
        notifyClients: false,
        navigation: 'caller' as const,
        // Why: every caller here is a tab click, shortcut, or palette pick —
        // the gesture that is supposed to wake a slept pane.
        intent: 'user' as const
      },
      timeoutMs: WEB_SESSION_TAB_RPC_TIMEOUT_MS
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<unknown>)
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
}): Promise<WebRuntimeSessionTabCloseOutcome> {
  const environmentId = resolveSessionTabEnvironmentId(args.environmentId)
  if (!environmentId) {
    return 'failed'
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)
  const reread = (): Promise<void> =>
    rereadAcceptingCurrent(environmentId, args.worktreeId, intentOwner.pairingRevision)
  const isLifecycleClose = args.reason !== 'user'
  if (isLifecycleClose && (!args.publicationEpoch || !args.terminalHandle)) {
    // Why: missing host-generation or terminal-incarnation evidence means keep;
    // a tab id alone can be stale or reused after reconnect.
    await reread()
    console.warn('[web-runtime-session] suppressed lifecycle close without incarnation evidence', {
      closeReason: args.reason
    })
    return 'failed'
  }

  // Why: begin before async id resolution so a stale snapshot cannot flash the closed tab back.
  const tickets: WebSessionTabCloseTicket[] = []
  const begin = (hostTabId: string): void => {
    const ticket = beginWebSessionTabClose(intentOwner, args.worktreeId, hostTabId, Date.now())
    if (ticket) {
      tickets.push(ticket)
    }
  }
  const immediateHostTabId = toHostSessionTabId(args.tabId)
  begin(immediateHostTabId)
  const close = (async () => {
    const hostTabId = await resolveHostTabId(environmentId, args.worktreeId, args.tabId)
    if (hostTabId !== immediateHostTabId) {
      begin(hostTabId)
    }
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
    return unwrapRuntimeRpcResult(
      response as RuntimeRpcResponse<RuntimeMobileSessionTabCloseResult | undefined>
    )
  })()
  return settleHostSessionTabClose({
    tickets: () => tickets,
    close,
    rereadAcceptingCurrent: reread,
    // Why: a paired host's lists travel apart from its answer, so read once after the close.
    readAfterClose: () =>
      refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
        expectedEnvironmentPairingRevision: intentOwner.pairingRevision
      })
  })
}
