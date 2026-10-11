import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  markStructuredAgentSessionLaunchesPublished,
  publishedStructuredSessions
} from '@/lib/structured-agent-session-launch-publication'
import {
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled
} from '@/lib/structured-agent-session-launch-registry'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { discardStructuredAgentSessionChatSends } from '@/lib/structured-agent-session-launch-prompt'
import { stopStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-message-sender'
import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { closeStructuredAgentSession } from './structured-agent-session-close'
import { readSessionTabsCloseAgentSessionCapability } from './structured-agent-session-client'
import {
  captureHostIdentityFence,
  isHostIdentityFenceCurrent,
  type HostIdentityFence
} from '@/store/host-catalog-fencing'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from './runtime-environment-revision'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionFocusOwner
} from './structured-agent-session-owner'
import { SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS } from '../../../shared/session-tab-close-ledger'
import { beginWebSessionCloseIntent } from './web-session-close-intent'
import {
  rereadHostSessionTabs,
  settleHostSessionTabClose,
  type HostSessionTabCloseAnswer
} from './host-session-tab-close'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'
import { captureWebSessionIntentOwner } from './web-runtime-session-environment'
import {
  callRuntimeRpc,
  ensureRuntimeEnvironmentCompatible,
  type RuntimeClientTarget
} from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

type HostTabCloseSettlement = PromiseSettledResult<HostSessionTabCloseAnswer | undefined>

const inFlightRetirements = new Map<
  string,
  { fence: HostIdentityFence; promise: Promise<HostTabCloseSettlement> }
>()

function retirementKey(
  target: RuntimeClientTarget,
  worktreeId: string,
  sessionId: string,
  pairingRevision: number | undefined
): string {
  return JSON.stringify([
    target.kind,
    target.kind === 'environment' ? target.environmentId : 'local',
    pairingRevision,
    worktreeId,
    sessionId
  ])
}

/** A reveal must follow the close this client has already started, including its capability await. */
export function pendingStructuredAgentSessionTabRetirement(
  target: RuntimeClientTarget,
  worktreeId: string,
  sessionId: string
): Promise<HostTabCloseSettlement> | undefined {
  const pending = inFlightRetirements.get(
    retirementKey(
      target,
      worktreeId,
      sessionId,
      target.kind === 'environment'
        ? getRuntimeEnvironmentRevision(target.environmentId)
        : undefined
    )
  )
  return pending && isHostIdentityFenceCurrent(pending.fence) ? pending.promise : undefined
}

/**
 * Best-effort host cleanup; local removal must never wait for bookkeeping. Settles with the host
 * tab close's own result, which decides whether the host may still list the chat.
 */
export function retireStructuredAgentSessionTab(args: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  onError?: (error: unknown) => void
}): Promise<HostTabCloseSettlement> {
  const expectedEnvironmentPairingRevision =
    args.target.kind === 'environment'
      ? getRuntimeEnvironmentRevision(args.target.environmentId)
      : undefined
  retireStructuredAgentSessionReadOwner(args.sessionId, args.target)
  const fence = captureHostIdentityFence({ target: args.target, at: 'local' })
  const key = retirementKey(
    args.target,
    args.worktreeId,
    args.sessionId,
    expectedEnvironmentPairingRevision
  )
  const existing = pendingStructuredAgentSessionTabRetirement(
    args.target,
    args.worktreeId,
    args.sessionId
  )
  if (existing) {
    return existing
  }
  const report = (error: unknown): void => {
    if (args.onError) {
      args.onError(error)
    } else {
      console.warn('[structured-agent-session] host retirement failed', error)
    }
  }
  const hostTabId = `agent-session:${args.sessionId}`
  let gaveUp = false
  const sendHostTabClose = async (): Promise<HostSessionTabCloseAnswer | undefined> => {
    // Why: a close the window already gave up on must not be sent late (after a slow
    // compatibility check), or the chat it showed again would vanish again.
    const throwIfGaveUp = (): void => {
      if (gaveUp) {
        throw new Error('session_tab_close_abandoned')
      }
      if (!isHostIdentityFenceCurrent(fence)) {
        throw new Error('session_tab_close_host_changed')
      }
    }
    const requestOptions = (): { expectedEnvironmentPairingRevision?: number } => ({
      expectedEnvironmentPairingRevision:
        args.target.kind === 'environment'
          ? resolveContinuedRuntimeEnvironmentRevision(
              args.target.environmentId,
              fence.pairingRevision
            )
          : undefined
    })
    // Why: a capable host's tab close also stops the chat and closes one still starting by its id.
    const capability = await readSessionTabsCloseAgentSessionCapability(
      args.target,
      requestOptions()
    ).catch(() => ({ supported: false, runtimeId: undefined }))
    throwIfGaveUp()
    if (args.target.kind === 'environment') {
      await ensureRuntimeEnvironmentCompatible(args.target.environmentId, requestOptions())
    }
    throwIfGaveUp()
    const options = {
      ...requestOptions(),
      expectedEnvironmentRuntimeId: capability.runtimeId
    }
    if (!capability.supported) {
      void closeStructuredAgentSession(args.target, args.sessionId, options).catch(report)
    }
    return callRuntimeRpc<HostSessionTabCloseAnswer | undefined>(
      args.target,
      'session.tabs.close',
      { worktree: toRuntimeWorktreeSelector(args.worktreeId), tabId: hostTabId, reason: 'user' },
      { timeoutMs: WEB_SESSION_TAB_RPC_TIMEOUT_MS, skipCompatibilityCheck: true, ...options }
    )
  }
  const promise: Promise<HostTabCloseSettlement> = sendHostTabClose().then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => {
      report(reason)
      return { status: 'rejected' as const, reason }
    }
  )
  inFlightRetirements.set(key, { fence, promise })
  const forget = (): void => {
    if (inFlightRetirements.get(key)?.promise === promise) {
      inFlightRetirements.delete(key)
    }
  }
  // Why: a hung local close must not hold back every later retry of this chat's close.
  const bound = setTimeout(() => {
    gaveUp = true
    forget()
  }, SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS)
  void promise.finally(() => {
    clearTimeout(bound)
    forget()
  })
  return promise
}

/** Mark cancellation before removing the row so a late host publication cannot resurrect it. */
export function beginStructuredAgentSessionTabClose(args: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  provisional: boolean
  onError?: (error: unknown) => void
}): void {
  if (args.provisional) {
    markStructuredAgentSessionLaunchCancelled(
      args.worktreeId,
      args.sessionId,
      executionHostIdForStructuredTarget(args.target)
    )
    discardStructuredAgentSessionChatSends(args.sessionId)
  } else {
    // Nothing more goes out, and nothing is dropped: one on its way settles from its answer, and
    // the rest goes back to the conversation's draft.
    stopStructuredAgentSessionSends(args.sessionId)
  }
  // Pinned to the pairing at close start, so a re-pair mid-close can't miss the clear.
  const intentOwner = captureWebSessionIntentOwner(
    structuredAgentSessionFocusOwner(args.target).environmentId
  )
  const hostTabId = `agent-session:${args.sessionId}`
  // Why: a host frame sent before the host handles the close still lists the chat and would re-add
  // it at the end of the strip. Floating-panel frames are never applied, so nothing there could
  // re-add the chat or ever confirm its close.
  if (args.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    void retireStructuredAgentSessionTab(args)
    return
  }
  const ticket = beginWebSessionCloseIntent(intentOwner, args.worktreeId, hostTabId, Date.now())
  const reread = (acceptCurrent: boolean): Promise<void> =>
    rereadHostSessionTabs(args.target, args.worktreeId, intentOwner.pairingRevision, acceptCurrent)
  void settleHostSessionTabClose({
    tickets: () => (ticket ? [ticket] : []),
    close: retireStructuredAgentSessionTab(args).then((settled) =>
      settled.status === 'fulfilled' ? settled.value : Promise.reject(settled.reason)
    ),
    reread,
    // Why: this machine's host emits its removal frame before the close answers; a paired server's
    // frames travel apart from its answer, so, as for its terminal closes, a read follows.
    readAfterClose: args.target.kind === 'environment',
    absentTabMayReturn: true
  })
}

/**
 * A paired host's frame, as this client may apply it: chats cancelled before their create landed
 * are retired on that host, and the rest settle any launch still waiting to learn they exist.
 */
export function acceptPairedHostStructuredSessions(
  frame: RuntimeMobileSessionTabsResult,
  environmentId: string
): RuntimeMobileSessionTabsResult {
  const snapshot = suppressCancelledStructuredSessionTabs(frame, {
    kind: 'environment',
    environmentId
  })
  markStructuredAgentSessionLaunchesPublished(
    toRuntimeExecutionHostId(environmentId),
    publishedStructuredSessions([snapshot])
  )
  return snapshot
}

/** A host snapshot containing a cancelled session is suppressed and retired again idempotently. */
export function suppressCancelledStructuredSessionTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  target: RuntimeClientTarget,
  onError?: (error: unknown) => void
): RuntimeMobileSessionTabsResult {
  const cancelledSessionIds = new Set<string>()
  for (const tab of snapshot.tabs) {
    if (
      tab.type === 'agent-session' &&
      hasStructuredAgentSessionLaunchCancellationTombstone(snapshot.worktree, tab.sessionId)
    ) {
      cancelledSessionIds.add(tab.sessionId)
    }
  }
  if (cancelledSessionIds.size === 0) {
    return snapshot
  }
  for (const sessionId of cancelledSessionIds) {
    void retireStructuredAgentSessionTab({
      target,
      worktreeId: snapshot.worktree,
      sessionId,
      onError
    })
  }
  const tabs = snapshot.tabs.filter(
    (tab) => tab.type !== 'agent-session' || !cancelledSessionIds.has(tab.sessionId)
  )
  const visibleTabIds = new Set(tabs.map((tab) => tab.id))
  return {
    ...snapshot,
    tabs,
    activeTabId:
      snapshot.activeTabId && visibleTabIds.has(snapshot.activeTabId) ? snapshot.activeTabId : null,
    activeTabType:
      snapshot.activeTabId && visibleTabIds.has(snapshot.activeTabId)
        ? snapshot.activeTabType
        : null,
    tabGroups: snapshot.tabGroups
      ?.map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((id) => visibleTabIds.has(id)),
        activeTabId:
          group.activeTabId && visibleTabIds.has(group.activeTabId) ? group.activeTabId : null,
        recentTabIds: group.recentTabIds?.filter((id) => visibleTabIds.has(id))
      }))
      .filter((group) => group.tabOrder.length > 0)
  }
}
