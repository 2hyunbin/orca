import {
  SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS,
  type SessionTabCloseOutcome
} from '../../../shared/session-tab-close-ledger'
import type { RuntimeClientTarget } from './runtime-rpc-client'
import { sessionTabCloseAnswerOutcome } from '../../../shared/session-tab-close-answer'
import { hasRuntimeRpcErrorCode } from './runtime-rpc-result'
import {
  settleWebSessionCloseIntents,
  isFailedWebSessionCloseIntents,
  type WebSessionCloseIntentTicket
} from './web-session-close-intent'

/**
 * Why 'unknown-tab' is its own outcome: it is the host's definitive answer that it has no such
 * tab, which is the only evidence that lets a client finish a teardown the host cannot. Every
 * other failure -- a dropped connection, a timeout -- is a "not now", and treating it the same
 * would tear down tabs a reachable host still holds.
 */
export type HostSessionTabCloseResult = 'applied' | 'unknown-tab' | 'failed'

export type HostSessionTabCloseAnswer = {
  refused?: boolean
  snapshotRepublished?: boolean
  refusalReason?: string
}

const CLOSE_UNANSWERED = Symbol('close-unanswered')

function withinCloseBound<T>(close: Promise<T>): Promise<T | typeof CLOSE_UNANSWERED> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<typeof CLOSE_UNANSWERED>((resolve) => {
    timer = setTimeout(() => resolve(CLOSE_UNANSWERED), SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS)
  })
  return Promise.race([close, bound]).finally(() => clearTimeout(timer))
}

/**
 * Re-reads one worktree from its host. `acceptCurrent` re-applies the version this window already
 * has, which a failed close needs because the host's unchanged list is never republished.
 */
export function rereadHostSessionTabs(
  target: RuntimeClientTarget,
  worktreeId: string,
  expectedEnvironmentPairingRevision: number | undefined,
  acceptCurrent: boolean
): Promise<void> {
  // Lazy imports: both refresh paths apply frames through modules that import this one.
  const reread =
    target.kind === 'environment'
      ? import('./web-runtime-session-snapshot').then(({ refreshWebRuntimeSessionTabsSnapshot }) =>
          refreshWebRuntimeSessionTabsSnapshot(target.environmentId, worktreeId, {
            acceptCurrentSnapshot: acceptCurrent,
            // A read that began before the close would still list the tab.
            afterCurrentInFlight: true,
            expectedEnvironmentPairingRevision
          })
        )
      : import('./local-structured-session-tabs-sync/inventory-refresh').then(
          ({ refreshLocalStructuredSessionWorktreeTabs }) =>
            refreshLocalStructuredSessionWorktreeTabs(worktreeId, {
              reacceptCurrentVersion: acceptCurrent
            })
        )
  return reread.catch((error: unknown) =>
    console.warn('[session-tabs] tab re-read after a close failed', error)
  )
}

/**
 * The one close lifecycle for a tab this window mirrors from a host, whatever its kind. The caller
 * has already begun the close records (synchronously, before pruning its own copy); this settles
 * them from the host's answer, and on failure re-reads the host so the tab comes back at once.
 */
export async function settleHostSessionTabClose(args: {
  tickets: () => readonly WebSessionCloseIntentTicket[]
  close: Promise<unknown>
  /** Never rejects. */
  reread: (acceptCurrent: boolean) => Promise<void>
  /** For hosts whose lists travel apart from the close answer: read once after an accepted close. */
  readAfterClose: boolean
  /** A chat's host answers "no such tab" while its list is not yet restored, then lists it again. */
  absentTabMayReturn?: boolean
}): Promise<HostSessionTabCloseResult> {
  let outcome: SessionTabCloseOutcome
  let result: HostSessionTabCloseResult
  try {
    const answer = await withinCloseBound(args.close)
    outcome = answer === CLOSE_UNANSWERED ? 'failed' : sessionTabCloseAnswerOutcome(answer)
    result = answer === CLOSE_UNANSWERED ? 'failed' : 'applied'
  } catch (error) {
    const hostHasNoSuchTab =
      hasRuntimeRpcErrorCode(error, 'tab_not_found') ||
      hasRuntimeRpcErrorCode(error, 'terminal_tab_not_found')
    outcome = !hostHasNoSuchTab ? 'failed' : args.absentTabMayReturn ? 'closed' : 'absent'
    result = hostHasNoSuchTab ? 'unknown-tab' : 'failed'
    console.warn(
      '[session-tabs] tab close failed:',
      error instanceof Error ? error.message : String(error)
    )
  }
  const tickets = [...args.tickets()]
  settleWebSessionCloseIntents(tickets, outcome, Date.now())
  if (outcome === 'failed') {
    void recoverFailedHostSessionTabs(tickets)
    void Promise.resolve()
      .then(() => args.reread(true))
      .catch((error: unknown) =>
        console.warn('[session-tabs] tab re-read after a close failed', error)
      )
  }
  if (outcome === 'closed' && args.readAfterClose) {
    await args.reread(false)
  }
  return result
}

async function recoverFailedHostSessionTabs(
  tickets: readonly WebSessionCloseIntentTicket[]
): Promise<void> {
  if (tickets.length === 0) {
    return
  }
  try {
    const { reprojectHostSessionTabSource } = await import('./host-session-tab-source-projection')
    if (!isFailedWebSessionCloseIntents(tickets, Date.now())) {
      return
    }
    // Aliases describe one close; replay once with its captured occurrence, not an alias without it.
    const ticket = tickets.find((candidate) => candidate.placement) ?? tickets[0]
    try {
      reprojectHostSessionTabSource(ticket)
    } catch (error) {
      console.warn('[session-tabs] could not restore closed tab from its host source', error)
    }
  } catch (error) {
    console.warn('[session-tabs] could not load closed tab recovery', error)
  }
}
