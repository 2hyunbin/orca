import {
  SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS,
  type SessionTabCloseOutcome
} from '../../../shared/session-tab-close-ledger'
import { hasRuntimeRpcErrorCode } from './runtime-rpc-result'
import { settleWebSessionTabClose, type WebSessionTabCloseTicket } from './web-session-close-intent'

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
}

const CLOSE_UNANSWERED = Symbol('close-unanswered')

/** Resolves to `CLOSE_UNANSWERED` once the close has run past the close record's own bound. */
function withinCloseBound<T>(close: Promise<T>): Promise<T | typeof CLOSE_UNANSWERED> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<typeof CLOSE_UNANSWERED>((resolve) => {
    timer = setTimeout(() => resolve(CLOSE_UNANSWERED), SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS)
  })
  return Promise.race([close, bound]).finally(() => clearTimeout(timer))
}

function closeOutcome(answer: HostSessionTabCloseAnswer | undefined): SessionTabCloseOutcome {
  if (answer?.refused !== true) {
    return 'closed'
  }
  // Why: a refusal that republished means the host kept a live tab, so the window must show it
  // again; one that did not (a dead leaf) stays hidden until the host's list drops it.
  return answer.snapshotRepublished === true ? 'failed' : 'refused'
}

/**
 * The one close lifecycle for a tab this window mirrors from a host, whatever its kind. The caller
 * has already begun the close records (synchronously, before pruning its own copy); this settles
 * them from the host's answer, and on failure re-reads the host so the tab comes back at once.
 */
export async function settleHostSessionTabClose(args: {
  tickets: () => readonly WebSessionTabCloseTicket[]
  close: Promise<HostSessionTabCloseAnswer | undefined>
  /** Re-reads this worktree from the host, re-applying the version the window already has. */
  rereadAcceptingCurrent: () => Promise<void> | void
  /** A read after a close the host accepted, for hosts whose lists travel apart from the answer. */
  readAfterClose?: () => Promise<void> | void
}): Promise<HostSessionTabCloseResult> {
  let outcome: SessionTabCloseOutcome
  let result: HostSessionTabCloseResult
  try {
    const answer = await withinCloseBound(args.close)
    outcome = answer === CLOSE_UNANSWERED ? 'failed' : closeOutcome(answer)
    // A refusal was still heard by the host; only an unanswered close is a "not now".
    result = answer === CLOSE_UNANSWERED ? 'failed' : 'applied'
  } catch (error) {
    const hostHasNoSuchTab =
      hasRuntimeRpcErrorCode(error, 'tab_not_found') ||
      hasRuntimeRpcErrorCode(error, 'terminal_tab_not_found')
    outcome = hostHasNoSuchTab ? 'absent' : 'failed'
    result = hostHasNoSuchTab ? 'unknown-tab' : 'failed'
    console.warn(
      '[session-tabs] tab close failed:',
      error instanceof Error ? error.message : String(error)
    )
  }
  const now = Date.now()
  for (const ticket of args.tickets()) {
    settleWebSessionTabClose(ticket, outcome, now)
  }
  if (outcome === 'failed') {
    await args.rereadAcceptingCurrent()
  } else if (outcome !== 'absent') {
    await args.readAfterClose?.()
  }
  return result
}
