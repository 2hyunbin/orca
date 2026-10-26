/**
 * The orchestrator's pure state machine: which trigger may start a distro's move, and what each
 * preview, move result, distro check (R38) or user action leaves the distro in.
 */
import type {
  WslMovePreview,
  WslMoveRefusalCode,
  WslMoveResult
} from '../../../shared/wsl-move/wsl-move-driver-types'
import type {
  WslMoveOrchestratorParkReason,
  WslMoveOrchestratorRecord,
  WslMoveOrchestratorState,
  WslMoveOrchestratorTrigger,
  WslMoveOrchestratorUserAction
} from '../../../shared/wsl-move/wsl-move-orchestrator-types'

/** Delay before automatic attempt n+1; the last entry repeats until attempts run out. */
export const WSL_MOVE_ORCHESTRATOR_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000
] as const
export const WSL_MOVE_ORCHESTRATOR_MAX_ATTEMPTS = WSL_MOVE_ORCHESTRATOR_BACKOFF_MS.length
export const WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS = 7 * 24 * 60 * 60_000
/** How often a deferred move previews again while its host stays ready. */
export const WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS = 60_000

/** What one preview or move result asks of the orchestrator. */
export type WslMoveOutcome =
  | { next: 'start' }
  | { next: 'idle' }
  /** This process already runs the move; nothing to record. */
  | { next: 'stay' }
  | {
      next: 'deferred'
      blockers: Extract<WslMoveOrchestratorState, { kind: 'deferred' }>['blockers']
    }
  | { next: 'transient'; reason: string }
  | { next: 'parked'; reason: WslMoveOrchestratorParkReason }
  | { next: 'waiting'; migrationId: string }
  | { next: 'done'; migrationId: string }

function refusalOutcome(code: WslMoveRefusalCode, preview: WslMovePreview | WslMoveResult) {
  switch (code) {
    case 'wsl_move_nothing_new':
    case 'wsl_move_unavailable':
      return { next: 'idle' } as const
    case 'wsl_move_already_running':
      return { next: 'stay' } as const
    case 'wsl_move_terminals_blocked':
      return {
        next: 'deferred',
        blockers: 'blockers' in preview ? (preview.blockers ?? []) : []
      } as const
    case 'wsl_move_export_incomplete':
      return { next: 'parked', reason: 'export-incomplete' } as const
    case 'wsl_move_manifest_too_large':
      return { next: 'parked', reason: 'manifest-too-large' } as const
    case 'wsl_move_cancelled':
      return { next: 'parked', reason: 'not-now' } as const
    case 'wsl_move_host_update_required':
    case 'wsl_move_already_in_flight':
    case 'wsl_move_host_unavailable':
    case 'wsl_move_pause_failed':
    case 'wsl_move_scope_changed':
    case 'wsl_move_finished_earlier_move':
      return { next: 'transient', reason: code } as const
  }
}

export function classifyWslMoveOutcome(result: WslMovePreview | WslMoveResult): WslMoveOutcome {
  switch (result.outcome) {
    case 'ready':
      return result.blockers.length > 0
        ? { next: 'deferred', blockers: result.blockers }
        : { next: 'start' }
    case 'refused':
      return refusalOutcome(result.code, result)
    case 'moved':
      return { next: 'done', migrationId: result.migrationId }
    case 'reset':
      return { next: 'transient', reason: result.detail }
    case 'waiting-for-host':
      return { next: 'waiting', migrationId: result.migrationId }
  }
}

export function newWslMoveOrchestratorRecord(
  distro: string,
  appVersion: string,
  now: number
): WslMoveOrchestratorRecord {
  return { distro, state: { kind: 'pending' }, attempts: 0, appVersion, updatedAt: now }
}

/** Whether a trigger may preview the distro's move now. Never true while one runs. */
export function mayStartWslMove(
  record: WslMoveOrchestratorRecord,
  trigger: WslMoveOrchestratorTrigger,
  now: number,
  appVersion: string
): boolean {
  const { state } = record
  if (state.kind === 'moving') {
    return false
  }
  if (trigger === 'user') {
    return state.kind !== 'distro-gone'
  }
  switch (state.kind) {
    case 'idle':
    case 'pending':
    case 'deferred':
    case 'waiting-for-host':
    case 'done':
      return true
    case 'backoff':
      return now >= state.nextAttemptAt
    case 'parked':
      if (state.reason === 'not-now') {
        return state.until !== undefined && now >= state.until
      }
      // A new build may carry the fix for whatever kept failing.
      return state.reason === 'attempts-exhausted' && record.appVersion !== appVersion
    case 'distro-gone':
    case 'restore-offered':
      return false
  }
}

function withState(
  record: WslMoveOrchestratorRecord,
  state: WslMoveOrchestratorState,
  now: number,
  changes: Partial<Pick<WslMoveOrchestratorRecord, 'attempts' | 'appVersion'>> = {}
): WslMoveOrchestratorRecord {
  return { ...record, ...changes, state, updatedAt: now }
}

function failedAttempt(
  record: WslMoveOrchestratorRecord,
  reason: string,
  now: number,
  appVersion: string
): WslMoveOrchestratorRecord {
  // A new build starts a fresh count.
  const attempts = (record.appVersion === appVersion ? record.attempts : 0) + 1
  const updateStillRequired =
    reason === 'wsl_move_host_update_required' &&
    record.state.kind === 'backoff' &&
    record.state.reason === reason
  if (updateStillRequired) {
    return withState(record, { kind: 'parked', reason: 'host-update-required' }, now, {
      attempts,
      appVersion
    })
  }
  if (attempts >= WSL_MOVE_ORCHESTRATOR_MAX_ATTEMPTS) {
    return withState(record, { kind: 'parked', reason: 'attempts-exhausted' }, now, {
      attempts,
      appVersion
    })
  }
  const delay = WSL_MOVE_ORCHESTRATOR_BACKOFF_MS[attempts - 1]
  return withState(record, { kind: 'backoff', nextAttemptAt: now + delay, reason }, now, {
    attempts,
    appVersion
  })
}

/**
 * The record after a preview or move result. `start` marks the move running; the caller runs it
 * and applies its result next.
 */
export function applyWslMoveOutcome(
  record: WslMoveOrchestratorRecord,
  outcome: WslMoveOutcome,
  context: { now: number; appVersion: string }
): WslMoveOrchestratorRecord {
  const { now, appVersion } = context
  switch (outcome.next) {
    case 'start':
      return withState(record, { kind: 'moving' }, now)
    case 'stay':
      return record
    case 'idle':
      // A distro moved earlier stays done: nothing new to move is its normal answer.
      return record.state.kind === 'done' ? record : withState(record, { kind: 'idle' }, now)
    case 'deferred':
      return withState(record, { kind: 'deferred', blockers: outcome.blockers }, now)
    case 'transient':
      return failedAttempt(record, outcome.reason, now, appVersion)
    case 'parked':
      return withState(
        record,
        outcome.reason === 'not-now'
          ? { kind: 'parked', reason: 'not-now', until: now + WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS }
          : { kind: 'parked', reason: outcome.reason },
        now
      )
    case 'waiting':
      return withState(record, { kind: 'waiting-for-host', migrationId: outcome.migrationId }, now)
    case 'done':
      return withState(record, { kind: 'done', migrationId: outcome.migrationId }, now, {
        attempts: 0,
        appVersion
      })
  }
}

/** Whether a finished move's distro is still the one it moved into (R38). */
export type WslMovedDistroVerdict =
  | 'present'
  /** Neither its name nor its recorded GUID is registered. */
  | 'gone'
  /** Registered under a new GUID, or the host lists none of the moved projects. */
  | 'replaced'
  /** The registry or host could not be read; nothing is concluded. */
  | 'unknown'

export function applyWslMovedDistroVerdict(
  record: WslMoveOrchestratorRecord,
  verdict: WslMovedDistroVerdict,
  now: number
): WslMoveOrchestratorRecord {
  switch (verdict) {
    case 'gone':
      return withState(record, { kind: 'distro-gone' }, now)
    case 'replaced':
      return withState(record, { kind: 'restore-offered' }, now)
    case 'present':
      // A distro registered again under its recorded GUID or name is back.
      return record.state.kind === 'distro-gone'
        ? withState(record, { kind: 'pending' }, now)
        : record
    case 'unknown':
      return record
  }
}

/** The record after a user action; `restore` applies only once the release succeeded. */
export function applyWslMoveUserAction(
  record: WslMoveOrchestratorRecord,
  action: WslMoveOrchestratorUserAction,
  now: number,
  appVersion: string
): WslMoveOrchestratorRecord {
  if (record.state.kind === 'moving') {
    return record
  }
  if (action === 'not-now') {
    return withState(
      record,
      { kind: 'parked', reason: 'not-now', until: now + WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS },
      now
    )
  }
  return withState(record, { kind: 'pending' }, now, { attempts: 0, appVersion })
}

/** A record read at startup: a move this process was running is not running any more. */
export function settleWslMoveOrchestratorRecord(
  record: WslMoveOrchestratorRecord,
  now: number
): WslMoveOrchestratorRecord {
  // The driver's own startup recovery resumes or resets the journal; the next trigger previews.
  return record.state.kind === 'moving' ? withState(record, { kind: 'pending' }, now) : record
}
