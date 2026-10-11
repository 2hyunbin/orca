import { SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS } from '../../../shared/session-tab-close-ledger'

/** The budget for a `session.tabs.*` RPC; a pending tab close gives up on its host at the same time. */
export const WEB_SESSION_TAB_RPC_TIMEOUT_MS = SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS
