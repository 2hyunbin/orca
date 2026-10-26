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

/** Delay after failed automatic attempt n; the attempt after the last delay parks if it fails. */
export const WSL_MOVE_ORCHESTRATOR_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000
] as const
export const WSL_MOVE_ORCHESTRATOR_MAX_ATTEMPTS = WSL_MOVE_ORCHESTRATOR_BACKOFF_MS.length + 1
export const WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS = 7 * 24 * 60 * 60_000
/** Timer re-checks of a deferred move; after the last, it waits for a wake or the user. */
export const WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS = [60_000, 5 * 60_000, 30 * 60_000] as const
/** A failure of Orca's own plumbing (no window to ask), retried without costing an attempt. */
export const WSL_MOVE_ORCHESTRATOR_UNCOUNTED_RETRY_MS = 5 * 60_000

/** Failures that say nothing about the move: the window could not be asked for its panes. */
const UNCOUNTED_FAILURES = new Set(['wsl_move_window_unavailable'])

type Blockers = Extract<WslMoveOrchestratorState, { kind: 'deferred' }>['blockers']

/** What one preview or move result asks of the orchestrator. */
export type WslMoveOutcome =
  | { next: 'start' }
  | { next: 'idle' }
  /** This process already runs the move; a run marked here goes back to waiting. */
  | { next: 'stay' }
  | { next: 'deferred'; blockers: Blockers }
  | { next: 'transient'; reason: string }
  | { next: 'parked'; reason: WslMoveOrchestratorParkReason }
  | { next: 'waiting'; migrationId: string }
  | { next: 'done'; migrationId: string }

function refusalOutcome(
  code: WslMoveRefusalCode,
  preview: WslMovePreview | WslMoveResult
): WslMoveOutcome {
  switch (code) {
    case 'wsl_move_nothing_new':
    case 'wsl_move_unavailable':
      return { next: 'idle' }
    case 'wsl_move_already_running':
      return { next: 'stay' }
    case 'wsl_move_terminals_blocked':
      return { next: 'deferred', blockers: 'blockers' in preview ? (preview.blockers ?? []) : [] }
    case 'wsl_move_export_incomplete':
      return { next: 'parked', reason: 'export-incomplete' }
    case 'wsl_move_manifest_too_large':
      return { next: 'parked', reason: 'manifest-too-large' }
    case 'wsl_move_cancelled':
      return { next: 'parked', reason: 'not-now' }
    case 'wsl_move_host_update_required':
    case 'wsl_move_already_in_flight':
    case 'wsl_move_host_unavailable':
    case 'wsl_move_pause_failed':
    case 'wsl_move_scope_changed':
    case 'wsl_move_finished_earlier_move':
      return { next: 'transient', reason: code }
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

function parkedMayStart(
  state: Extract<WslMoveOrchestratorState, { kind: 'parked' }>,
  newBuild: boolean,
  now: number
): boolean {
  switch (state.reason) {
    case 'not-now':
      return state.until !== undefined && now >= state.until
    // A new build may carry the fix for whatever kept failing, or the host's update.
    case 'attempts-exhausted':
    case 'host-update-required':
      return newBuild
    case 'export-incomplete':
    case 'manifest-too-large':
    case 'declined':
    case 'removal-pending':
      return false
  }
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
      return parkedMayStart(state, record.appVersion !== appVersion, now)
    case 'distro-gone':
    case 'restore-offered':
      return false
  }
}

/** Ms until the timer re-checks this state; null when only a trigger may. */
export function wslMoveOrchestratorTimerDelay(
  record: WslMoveOrchestratorRecord,
  now: number
): number | null {
  const { state } = record
  if (state.kind === 'backoff') {
    return Math.max(0, state.nextAttemptAt - now)
  }
  return state.kind === 'deferred'
    ? (WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS[state.rechecks] ?? null)
    : null
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
  if (UNCOUNTED_FAILURES.has(reason)) {
    return withState(
      record,
      { kind: 'backoff', nextAttemptAt: now + WSL_MOVE_ORCHESTRATOR_UNCOUNTED_RETRY_MS, reason },
      now
    )
  }
  // A new build starts a fresh count.
  const attempts = (record.appVersion === appVersion ? record.attempts : 0) + 1
  const counted = { attempts, appVersion }
  // One retry, then the host waits for a newer build: from a backoff, or after a new version.
  const updateStillRequired =
    reason === 'wsl_move_host_update_required' &&
    ((record.state.kind === 'backoff' && record.state.reason === reason) ||
      (record.state.kind === 'parked' && record.state.reason === 'host-update-required'))
  if (updateStillRequired) {
    return withState(record, { kind: 'parked', reason: 'host-update-required' }, now, counted)
  }
  if (attempts >= WSL_MOVE_ORCHESTRATOR_MAX_ATTEMPTS) {
    return withState(record, { kind: 'parked', reason: 'attempts-exhausted' }, now, counted)
  }
  const delay = WSL_MOVE_ORCHESTRATOR_BACKOFF_MS[attempts - 1]
  return withState(record, { kind: 'backoff', nextAttemptAt: now + delay, reason }, now, counted)
}

/**
 * The record after a preview or move result. `start` marks the move running; the caller runs it
 * and applies its result next.
 */
export function applyWslMoveOutcome(
  record: WslMoveOrchestratorRecord,
  outcome: WslMoveOutcome,
  context: { now: number; appVersion: string; trigger: WslMoveOrchestratorTrigger }
): WslMoveOrchestratorRecord {
  const { now, appVersion } = context
  switch (outcome.next) {
    case 'start':
      return withState(record, { kind: 'moving' }, now)
    case 'stay':
      // Another run of this process owns the move; this one must not stay marked running.
      return record.state.kind === 'moving' ? withState(record, { kind: 'pending' }, now) : record
    case 'idle':
      // A distro moved earlier stays done: nothing new to move is its normal answer.
      return record.state.kind === 'done' ? record : withState(record, { kind: 'idle' }, now)
    case 'deferred': {
      // Only timer re-checks spend the series; a wake or the user starts it again.
      const rechecks =
        context.trigger === 'timer' && record.state.kind === 'deferred'
          ? record.state.rechecks + 1
          : 0
      return withState(record, { kind: 'deferred', blockers: outcome.blockers, rechecks }, now)
    }
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
  /** The host lists none of the moved projects (needs the host-catalog check). */
  | 'replaced'
  /** The registry or host could not be read, or only the GUID differs; nothing is concluded. */
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
      // A distro registered again, or whose host still has the projects, is back.
      return record.state.kind === 'distro-gone' || record.state.kind === 'restore-offered'
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

/** "Use on this computer again" is the user saying no: nothing moves the distro until Retry. */
export function applyWslMoveReleasedByUser(
  record: WslMoveOrchestratorRecord,
  now: number
): WslMoveOrchestratorRecord {
  return withState(record, { kind: 'parked', reason: 'declined' }, now)
}

/** A host whose Remove is unfinished is the user's to settle; park the distro until they act. */
export function applyWslMoveHostRemovalPending(
  record: WslMoveOrchestratorRecord,
  now: number
): WslMoveOrchestratorRecord {
  return withState(record, { kind: 'parked', reason: 'removal-pending' }, now)
}

/** A record read at startup, made true to what survived the last process. */
export function settleWslMoveOrchestratorRecord(
  record: WslMoveOrchestratorRecord,
  now: number,
  hasFinishedMove: boolean
): WslMoveOrchestratorRecord {
  // The driver's own startup recovery resumes or resets the journal; the next trigger previews.
  if (record.state.kind === 'moving') {
    return withState(record, { kind: 'pending' }, now)
  }
  // A Restore that released the move before the app quit has nothing left to restore.
  return record.state.kind === 'restore-offered' && !hasFinishedMove
    ? withState(record, { kind: 'pending' }, now)
    : record
}

/** Records that differ only in when they were written are the same decision. */
export function sameWslMoveOrchestratorRecord(
  a: WslMoveOrchestratorRecord | undefined,
  b: WslMoveOrchestratorRecord
): boolean {
  return (
    a !== undefined &&
    a.attempts === b.attempts &&
    a.appVersion === b.appVersion &&
    JSON.stringify(a.state) === JSON.stringify(b.state)
  )
}
