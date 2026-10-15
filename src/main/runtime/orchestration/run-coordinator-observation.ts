/**
 * Whether a Run's coordinator can read what its workers send, read off the party its binding names
 * on every call. The binding records only who last bound the Run, never whether that party still
 * exists, so this is never stored.
 */

import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../shared/orca-session-address'
import type { OrcaRuntimeService } from '../orca-runtime'
import { resolveStructuredWorkerIdentity } from '../structured-worker-authority'
import { observeChatAssignee } from './chat-assignee'
import type { OrchestrationDb } from './db'
import { UNBOUND_RUN_ID } from './db/contract-constants'
import { handleLessCoordinatorSessionId } from './structured-session-mail-target'
import type { RunRow } from './types'

export type RunCoordinatorObservation = {
  /** Where mail to this coordinator is queued; absent when another host coordinates. */
  address?: string
  /** A chat at rest is `live`: the mail that reaches it starts its agent. */
  status: 'live' | 'exited' | 'unverifiable'
  reason?: string
}

/** The legacy Run is inspect-only, and the unbound one files mail between terminals in no Run. */
export function runTakesCoordinator(run: Pick<RunRow, 'id' | 'legacy'>): boolean {
  return run.legacy !== 1 && run.id !== UNBOUND_RUN_ID
}

/** Null when no coordinator is bound: mail waits in the Run mailbox until one runs run-use. */
export async function observeRunCoordinator(
  runtime: Pick<
    OrcaRuntimeService,
    | 'ensureStructuredAgentSessionHost'
    | 'getTerminalLivenessVerdict'
    | 'getTerminalHandleForPaneKey'
  >,
  db: OrchestrationDb,
  run: RunRow
): Promise<RunCoordinatorObservation | null> {
  // A worker host's stub of a federated Run: the coordinator is bound, and observable, on its home.
  if (run.home_database !== 'this_database') {
    return { status: 'unverifiable', reason: 'The Run is coordinated from another host.' }
  }
  const handle = run.coordinator_handle
  const sessionId =
    handleLessCoordinatorSessionId(run) ??
    (handle ? (resolveStructuredWorkerIdentity(handle, db)?.sessionId ?? null) : null)
  if (sessionId !== null && isOrcaSessionId(sessionId)) {
    // After a restart nothing may have installed the host yet, and its records are what this reads.
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    const observed = observeChatAssignee(sessionId, db)
    return {
      address: handle ?? formatOrcaSessionAddress(sessionId),
      status: observed.status,
      ...(observed.status === 'live' ? {} : { reason: observed.reason })
    }
  }
  // A terminal's pane outlives the launch that minted the bound handle.
  const terminal =
    (run.coordinator_pane_key
      ? runtime.getTerminalHandleForPaneKey(run.coordinator_pane_key)
      : null) ?? handle
  if (!terminal) {
    return null
  }
  const verdict = runtime.getTerminalLivenessVerdict(terminal)
  if (!verdict) {
    // Also the answer for a healthy terminal before the first inventory sweep observes it.
    return {
      address: terminal,
      status: 'unverifiable',
      reason: 'No liveness observation of the terminal yet.'
    }
  }
  return {
    address: terminal,
    status: verdict.status,
    ...(verdict.status === 'unverifiable' ? { reason: verdict.reason } : {})
  }
}
