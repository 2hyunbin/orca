import type { DispatchContextRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { isSelfCreatedDispatch } from '../dispatch-depth'
import type { OrchestrationDb } from '../orchestration-db'
import {
  mailboxAddressOf,
  type OrchestrationCoordinatorKey
} from '../../orchestration-caller-identity'
import { workerSeatGrabSql } from './run-coordinator-mail-routing'

/**
 * The caller's live Dispatches, matched the way `check` and `send` find a worker's Dispatch: its
 * address, then its pane. A context-only self-dispatch is a coordinator's own bookkeeping, not work
 * for anyone, so it never makes the caller a worker.
 */
export function findCallerWorkerDispatches(
  db: OrchestrationDb,
  caller: OrchestrationCoordinatorKey
): DispatchContextRow[] {
  const address = mailboxAddressOf(caller)
  if (address === null) {
    return []
  }
  return db
    .getActiveDispatchMailboxOwners(address, caller.paneKey ?? undefined)
    .filter((dispatch) => !isSelfCreatedDispatch(dispatch))
}

/**
 * A Run the worker legitimately coordinated: its address is one of the Run's remembered coordinator
 * addresses and was not a seat grab, or it dispatched work into the Run while working one of its
 * Dispatches (which survives a reissued terminal handle).
 */
function workerCoordinatedRun(
  db: OrchestrationDb,
  address: string,
  dispatches: readonly DispatchContextRow[],
  runId: string
): boolean {
  const ids = dispatches.map((dispatch) => dispatch.id)
  return Boolean(
    db.db
      .prepare(
        `SELECT 1 WHERE EXISTS (
           SELECT 1 FROM run_coordinator_handles AS alias
           WHERE alias.run_id = ? AND alias.terminal_handle = ? AND NOT ${workerSeatGrabSql('alias')}
         ) OR EXISTS (
           SELECT 1 FROM dispatch_contexts
           WHERE run_id = ? AND creator_dispatch_id IN (${ids.map(() => '?').join(', ')})
         )`
      )
      .get(runId, address, runId, ...ids)
  )
}

/**
 * Why a worker may not coordinate this Run, or null when it may or the caller is not a worker. A
 * worker coordinates only Runs it created; it never coordinates the Run it works for, and never
 * takes a Run over. Derived from the Dispatch and coordinator-address rows, with no liveness probe.
 */
export function workerRunBindingRefusal(
  db: OrchestrationDb,
  caller: OrchestrationCoordinatorKey,
  runId: string,
  attempted: { takeover: boolean; bind: boolean }
): OrchestrationError | null {
  const dispatches = findCallerWorkerDispatches(db, caller)
  const address = mailboxAddressOf(caller)
  const first = dispatches[0]
  if (!first || address === null) {
    return null
  }
  const own = dispatches.find((dispatch) => dispatch.run_id === runId)
  if (own) {
    return workerRefusal(
      'worker_cannot_coordinate_own_run',
      own,
      `Run ${runId} is the Run you work for (Dispatch ${own.id}); it belongs to your coordinator.`,
      attempted.bind
    )
  }
  if (attempted.takeover) {
    return workerRefusal(
      'worker_cannot_take_over_run',
      first,
      `You work Dispatch ${first.id} in Run ${first.run_id}, and a worker never takes a Run over.`,
      attempted.bind
    )
  }
  if (workerCoordinatedRun(db, address, dispatches, runId)) {
    return null
  }
  return workerRefusal(
    'worker_cannot_take_over_run',
    first,
    `You work Dispatch ${first.id} in Run ${first.run_id}, and workers coordinate only Runs they created; Run ${runId} is not one of yours.`,
    attempted.bind
  )
}

function workerRefusal(
  code: string,
  dispatch: DispatchContextRow,
  role: string,
  bind: boolean
): OrchestrationError {
  const subRun = bind
    ? ' To coordinate sub-workers, create your own Run with `orchestration run-create`.'
    : ''
  return new OrchestrationError(
    code,
    `${role} ${WORKER_MAIL_HINT}${subRun} ${staleDispatchHint(dispatch)} No effects were applied.`,
    { effectsApplied: false, dispatchId: dispatch.id }
  )
}

const WORKER_MAIL_HINT =
  'Your own mail arrives through plain `orchestration check` (no --run); report with `orchestration send`.'

// Why worker-abandon, not worker-stop: stop closes the Dispatch's terminal, which may be the caller's own.
function staleDispatchHint(dispatch: DispatchContextRow): string {
  return `If nothing is working Dispatch ${dispatch.id} any more, its Run's coordinator or the user can end it with \`orca orchestration worker-abandon --dispatch ${dispatch.id}\`; this then works.`
}

/** What a worker with no Run of its own is told instead of "bind a Run first". */
export function unboundWorkerMessage(dispatch: DispatchContextRow): string {
  return `You work Dispatch ${dispatch.id} in Run ${dispatch.run_id} and are not bound to a Run of your own. ${WORKER_MAIL_HINT} To coordinate sub-workers, create your own Run with \`orchestration run-create\`. No effects were applied.`
}
