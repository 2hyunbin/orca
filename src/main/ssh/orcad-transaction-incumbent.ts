/** The incumbent slot across a journaled activation or rollback: retire it, then put it back. */
import type { OrcadActivationLockControl } from '../managed-server/activation/orcad-activation-lock'
import type { OrcadSnapshotVerdict } from '../managed-server/activation/orcad-activation-transaction'
import type { OrcadRestartAdmissionPort } from './orcad-restart-admission-client'
import type { OrcadDeployOptions } from './orcad-remote-deploy'
import { orcadStopFreedTheHost } from '../managed-server/install/orcad-remote-process-control'
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import { planOrcadUpdate, type OrcadUpdateDecision } from './orcad-update-plan'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from './orcad-daemon-protocol-crossing'
import { withoutAbortSignal } from '../managed-server/install/orcad-remote-runtime-control'
import {
  launchOrcadSlot,
  slotLiveness,
  stopOrcadSlot,
  ORCAD_SLOT_STOP_WAIT_SECONDS,
  type OrcadSlotIdentity,
  type OrcadSlotOptions
} from './orcad-recovery-slot'
import { recoverOrcadIncumbent } from './orcad-incumbent-recovery'
import { errorMessage } from '../../shared/error-message'
import { ORCAD_UPDATE_ADMISSION_STOP_BY_MS } from '../../shared/orcad-terminal-census'

export type OrcadIncumbentRestart =
  | { kind: 'host'; admission: OrcadRestartAdmissionPort; token: string }
  /** `recountedAt`: when the recount that closed the older host's terminal admission began. */
  | { kind: 'legacy'; recountedAt: number }
type OrcadUpdateDeferral = Extract<OrcadUpdateDecision, { action: 'defer' }>

/** Once the recount may have closed it; a failed reopen only leaves the fence to lapse on its own. */
export async function reopenIncumbentAdmission(
  options: Pick<OrcadDeployOptions, 'releaseIncumbentAdmission'>
): Promise<void> {
  await options.releaseIncumbentAdmission().catch(() => {})
}

/** Leaves the incumbent serving: frees its reservation, or reopens an older host's recount fence. */
export async function abandonIncumbentRestart(
  options: Pick<OrcadDeployOptions, 'releaseIncumbentAdmission'>,
  restart: OrcadIncumbentRestart | null
): Promise<void> {
  if (restart?.kind === 'host') {
    await restart.admission.release(restart.token)
  } else if (restart?.kind === 'legacy') {
    await reopenIncumbentAdmission(options)
  }
}

/** An older host's recount fence lapses on its own; a stop after that could kill a later terminal. */
export function incumbentRecountLapsed(
  restart: OrcadIncumbentRestart | null,
  now: number
): boolean {
  return restart?.kind === 'legacy' && now - restart.recountedAt > ORCAD_UPDATE_ADMISSION_STOP_BY_MS
}

/**
 * Reserves the counted incumbent's restart and replans on the census taken under it, so work
 * started during the upload still defers. Explicit Force can bootstrap a proven older host.
 */
export async function reserveIncumbentRestart(
  options: Pick<
    OrcadDeployOptions,
    'restartAdmission' | 'force' | 'census' | 'recountCensus' | 'releaseIncumbentAdmission'
  >,
  input: { record: OrcadActivationRecord; candidateVersion: string; counted: boolean; now: number }
): Promise<({ action: 'reserved' } & OrcadIncumbentRestart) | OrcadUpdateDeferral> {
  const admission = options.restartAdmission
  const notReserved = (reason: string): OrcadUpdateDeferral => ({
    action: 'defer',
    code: 'orcad_update_restart_not_reserved',
    reason
  })
  if (!input.counted) {
    return notReserved('This Orca server cannot reserve a safe restart, so it keeps serving.')
  }
  if (options.force && options.census.restartAdmissionSupported === false) {
    // The older host is stopped from outside, so its recount closes terminal admission until the
    // stop; every attempt that stops nothing reopens it. A failed recount reads as unverifiable.
    const census = await options.recountCensus().catch(() => null)
    if (census?.restartAdmissionSupported !== false) {
      await reopenIncumbentAdmission(options)
      return notReserved('The older server could not be verified again. Nothing was stopped.')
    }
    const legacyPlan = planOrcadUpdate({
      record: input.record,
      candidateVersion: input.candidateVersion,
      census,
      candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
      force: true
    })
    if (legacyPlan.action === 'proceed') {
      return { action: 'reserved', kind: 'legacy', recountedAt: input.now }
    }
    await reopenIncumbentAdmission(options)
    return legacyPlan.action === 'defer' ? legacyPlan : notReserved(legacyPlan.reason)
  }
  if (!admission) {
    return notReserved('This Orca server cannot reserve a safe restart, so it keeps serving.')
  }
  const reserved = await admission.reserve(options.force === true)
  // A refusal that carries its census replans too, so an opened terminal keeps its own code.
  const plan = reserved.census
    ? planOrcadUpdate({
        record: input.record,
        candidateVersion: input.candidateVersion,
        census: reserved.census,
        candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
        ...(options.force !== undefined ? { force: options.force } : {})
      })
    : null
  if (reserved.status === 'reserved') {
    if (plan?.action === 'proceed') {
      return { action: 'reserved', kind: 'host', admission, token: reserved.token }
    }
    await admission.release(reserved.token)
  }
  if (plan?.action === 'defer') {
    return plan
  }
  return notReserved(
    reserved.status === 'defer' ? reserved.reason : 'The server reserved a restart it cannot take.'
  )
}

/** How the incumbent's own restart ended; `refused` means new work kept it serving. */
export type OrcadIncumbentRestartOutcome =
  | { outcome: 'exited' }
  | { outcome: 'refused' }
  /** `stopMayBeUnderway`: false only when nothing was sent, so the host keeps serving. */
  | { outcome: 'unconfirmed'; reason: string; stopMayBeUnderway: boolean }

/**
 * Lets the incumbent end itself through its reservation, then waits for its process to go.
 * A capable host is never signaled after a refused or lost commit: new work may have won.
 */
export async function commitIncumbentRestart(
  options: OrcadSlotOptions,
  incumbent: OrcadSlotIdentity,
  lock: OrcadActivationLockControl,
  restart: OrcadIncumbentRestart
): Promise<OrcadIncumbentRestartOutcome> {
  if (restart.kind === 'legacy') {
    const stopped = await stopOrcadSlot(options, incumbent.remoteDir, false)
    if (orcadStopFreedTheHost(stopped)) {
      return { outcome: 'exited' }
    }
    const stopMayBeUnderway = stopped === 'still-running' || stopped === 'unconfirmed'
    if (stopMayBeUnderway) {
      lock.retain()
    }
    return {
      outcome: 'unconfirmed',
      reason: `The older server's stop was not confirmed (${stopped}).`,
      stopMayBeUnderway
    }
  }
  const { admission, token } = restart
  const commit = await admission.commit(token)
  if (commit === 'refused') {
    await admission.release(token)
    return { outcome: 'refused' }
  }
  if (commit === 'unknown') {
    await admission.release(token)
  }
  if (await awaitOrcadSlotExit(options, incumbent.remoteDir)) {
    return { outcome: 'exited' }
  }
  // A committed or possibly committed shutdown may still finish, so recovery must see the journal.
  lock.retain()
  const asked = commit === 'committed' ? 'accepting' : 'being asked for'
  return {
    outcome: 'unconfirmed',
    reason:
      `Could not verify that orcad ${incumbent.version} exited within ` +
      `${ORCAD_SLOT_STOP_WAIT_SECONDS}s of ${asked} its restart.`,
    stopMayBeUnderway: true
  }
}

async function awaitOrcadSlotExit(options: OrcadSlotOptions, remoteDir: string): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let waited = 0; ; waited++) {
    if ((await slotLiveness(options, remoteDir).catch(() => 'UNKNOWN')) === 'DEAD') {
      return true
    }
    if (waited >= ORCAD_SLOT_STOP_WAIT_SECONDS) {
      return false
    }
    await sleep(1_000)
  }
}

export async function restartAfterSnapshotFailure(
  options: OrcadSlotOptions,
  incumbent: OrcadSlotIdentity,
  lock: OrcadActivationLockControl
): Promise<string> {
  try {
    await launchOrcadSlot(withoutAbortSignal(options), incumbent)
    lock.recovered()
    return `orcad ${incumbent.version} was restarted and is serving again.`
  } catch (error) {
    lock.retain()
    return `restarting orcad ${incumbent.version} failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/**
 * Restores `restoreState` when it was replaced, then restarts the incumbent; both slots are
 * already proven exited. Null on success; otherwise why not, with the fence kept.
 */
export async function putTransactionIncumbentBack(
  options: OrcadSlotOptions,
  lock: OrcadActivationLockControl,
  input: {
    transactionStartedAt: string
    launchedVersion: string | null
    incumbent: OrcadSlotIdentity | null
    restoreState: OrcadSnapshotVerdict | null
    launchedFromState?: OrcadSnapshotVerdict | null
  }
): Promise<string | null> {
  try {
    const recovery = await recoverOrcadIncumbent(withoutAbortSignal(options), {
      ...input,
      slotsProvenExited: true
    })
    if (recovery.outcome === 'refused') {
      lock.retain()
      return recovery.reason
    }
    lock.recovered()
    return null
  } catch (error) {
    lock.retain()
    return `Restoring the previous version failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/** Stop the build this run launched, then put the incumbent back only on safe state. */
export async function restoreAfterRejectedCandidate(
  options: OrcadSlotOptions,
  lock: OrcadActivationLockControl,
  input: {
    launchedDir: string
    launchedVersion: string
    transactionStartedAt: string
    incumbent: OrcadSlotIdentity | null
    restoreState: OrcadSnapshotVerdict | null
    launchedFromState?: OrcadSnapshotVerdict | null
  }
): Promise<string> {
  const { launchedDir, ...restore } = input
  const stopped = await stopOrcadSlot(withoutAbortSignal(options), launchedDir, true).catch(
    (error: unknown) => `unverifiable: ${errorMessage(error)}`
  )
  if (stopped !== 'stopped' && stopped !== 'already-exited') {
    lock.retain()
    return (
      `orcad ${input.launchedVersion} could not be confirmed stopped (${stopped}), so nothing ` +
      'was restored over state it may still own. This host requires recovery.'
    )
  }
  const failure = await putTransactionIncumbentBack(options, lock, restore)
  return (
    failure ??
    (input.incumbent
      ? `orcad ${input.incumbent.version} was restarted and is serving again.`
      : 'No previous version was active, so this host is now serving nothing.')
  )
}
