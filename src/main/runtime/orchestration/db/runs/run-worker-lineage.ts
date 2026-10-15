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
 * The caller's live Dispatch that works for this Run: one in the Run itself, or one started
 * from work in it (recorded by creator_dispatch_id). The caller is matched the way `check` and
 * `send` find a worker's Dispatch: its address, then its pane. A context-only self-dispatch is
 * a coordinator's own bookkeeping, not work for anyone, so it never counts.
 */
export function findCallerDispatchWorkingForRun(
  db: OrchestrationDb,
  caller: OrchestrationCoordinatorKey,
  runId: string
): DispatchContextRow | undefined {
  const address = mailboxAddressOf(caller)
  if (address === null) {
    return undefined
  }
  for (const own of db.getActiveDispatchMailboxOwners(address, caller.paneKey ?? undefined)) {
    if (isSelfCreatedDispatch(own)) {
      continue
    }
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
  const mail =
    'Your own mail arrives through plain `orchestration check` (no --run); report with `orchestration send`.'
  const bindOnly =
    attempted === 'bind'
      ? ' To coordinate sub-workers, create your own Run with `orchestration run-create`. If you must take this Run over, first finish your Dispatch with worker_done.'
      : ''
  return new OrchestrationError(
    'worker_cannot_coordinate_own_run',
    `${role} ${mail}${bindOnly} No effects were applied.`,
    { effectsApplied: false }
  )
}
