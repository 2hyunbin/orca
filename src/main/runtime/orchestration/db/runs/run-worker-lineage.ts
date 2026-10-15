import type { DispatchContextRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { isSelfCreatedDispatch } from '../dispatch-depth'
import type { OrchestrationDb } from '../orchestration-db'
import {
  mailboxAddressOf,
  type OrchestrationCoordinatorKey
} from '../../orchestration-caller-identity'

// Why: creator links only point at older rows, so this caps a corrupt chain, not real nesting.
const MAX_LINEAGE_STEPS = 32

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
 * The caller's live Dispatch that works for this Run: one in the Run itself, or one started from
 * work in it (recorded by creator_dispatch_id).
 */
export function findCallerDispatchWorkingForRun(
  db: OrchestrationDb,
  caller: OrchestrationCoordinatorKey,
  runId: string
): DispatchContextRow | undefined {
  for (const own of findCallerWorkerDispatches(db, caller)) {
    let row: DispatchContextRow | undefined = own
    for (let step = 0; row && step < MAX_LINEAGE_STEPS; step++) {
      if (row.run_id === runId) {
        return own
      }
      row = row.creator_dispatch_id ? db.getDispatchContextById(row.creator_dispatch_id) : undefined
    }
  }
  return undefined
}

const WORKER_MAIL_HINT =
  'Your own mail arrives through plain `orchestration check` (no --run); report with `orchestration send`.'
const SUB_RUN_HINT =
  'To coordinate sub-workers, create your own Run with `orchestration run-create`.'

/** Refuse a worker acting as the coordinator of a Run it works for; never points it at run-use. */
export function workerCannotCoordinateRunError(
  dispatch: DispatchContextRow,
  runId: string,
  attempted: 'bind' | 'act'
): OrchestrationError {
  const role =
    dispatch.run_id === runId
      ? `You work Dispatch ${dispatch.id} in Run ${runId}, so that Run belongs to your coordinator and you cannot coordinate it.`
      : `You work Dispatch ${dispatch.id} in Run ${dispatch.run_id}, which was started from work in Run ${runId}, so you cannot coordinate Run ${runId}.`
  const bindOnly = attempted === 'bind' ? ` ${SUB_RUN_HINT}` : ''
  return new OrchestrationError(
    'worker_cannot_coordinate_own_run',
    `${role} ${WORKER_MAIL_HINT}${bindOnly} No effects were applied.`,
    { effectsApplied: false }
  )
}

/** A worker never takes over a Run, even with the flag: the flag carries a user's intent, not a worker's. */
export function workerCannotTakeOverRunError(
  dispatch: DispatchContextRow,
  runId: string
): OrchestrationError {
  return new OrchestrationError(
    'worker_cannot_take_over_run',
    `You work Dispatch ${dispatch.id} in Run ${dispatch.run_id}, so you cannot take over Run ${runId}. ${WORKER_MAIL_HINT} ${SUB_RUN_HINT} No effects were applied.`,
    { effectsApplied: false }
  )
}

/** What a worker with no Run of its own is told instead of "bind a Run first". */
export function unboundWorkerMessage(dispatch: DispatchContextRow): string {
  return `You work Dispatch ${dispatch.id} in Run ${dispatch.run_id} and are not bound to a Run of your own. ${WORKER_MAIL_HINT} ${SUB_RUN_HINT} No effects were applied.`
}
