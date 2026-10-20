import { setTimeout as delay } from 'node:timers/promises'
import { runProcess } from '@orca/process-host'
import { parseProcessTable, type ProcessTableRow } from '../pty-process-table-parser'
import { hasUnambiguousStartTime } from '../pty-descendant-termination'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'

// Covers the one stop the supervisor cannot make itself: its own SIGKILL leaves the provider's
// detached group running, so Orca, which outlives it, finishes the stop. POSIX only: Windows
// providers have no supervisor.

const PROCESS_ROW_TIMEOUT_MS = 2_000
// The supervisor disconnects right after reporting, so this bounds only a wedged channel.
const REPORT_END_WAIT_MS = 1_000
const IDENTITY_READ_ATTEMPTS = 3
const SECOND_BOUNDARY_MARGIN_MS = 50

/** A provider group proven ours while its supervisor still parented the leader. */
export type ProviderGroupIdentity = { pgid: number; startedAt: string }

/** `null`: no such process. `'unverifiable'`: the read failed, which proves nothing. */
export type ProcessRowRead = ProcessTableRow | null | 'unverifiable'

export type ProviderGroupSweepVerdict = 'absent' | 'killed' | 'refused'

export type ProviderGroupGuardDeps = {
  site: string
  readProcessRow?: (pid: number) => Promise<ProcessRowRead>
  signalGroup?: (pgid: number, signal: NodeJS.Signals | 0) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onProven?: (identity: ProviderGroupIdentity) => void
  /** `unproven`: no group was reported and proven ours, so nothing was swept. */
  onSwept?: (verdict: ProviderGroupSweepVerdict | 'unproven') => void
}

type GuardedChild = {
  readonly pid?: number
  readonly connected: boolean
  once(event: 'exit' | 'disconnect', listener: () => void): unknown
  once(event: 'message', listener: (message: unknown) => void): unknown
}

export async function readPosixProcessRow(pid: number): Promise<ProcessRowRead> {
  try {
    const result = await runProcess({
      program: 'ps',
      args: ['-o', 'pid=,ppid=,pgid=,lstart=', '-p', String(pid)],
      // The same locale on every read, so two reads of one process compare equal.
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      timeoutMs: PROCESS_ROW_TIMEOUT_MS,
      maxOutputBytes: 4096
    })
    const row = parseProcessTable(result.stdout).find((entry) => entry.pid === pid) ?? null
    if (row) {
      return row
    }
    // ps exits 1 with no rows for a pid that does not exist; anything else is a failed read.
    return !result.timedOut && result.code === 1 ? null : 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}

function defaultSignalGroup(pgid: number, signal: NodeJS.Signals | 0): void {
  process.kill(-pgid, signal)
}

/** SIGKILLs a surviving provider group, never one whose leader pid now names another process. */
export async function sweepOrphanedProviderGroup(
  identity: ProviderGroupIdentity,
  deps: ProviderGroupGuardDeps
): Promise<ProviderGroupSweepVerdict> {
  const signalGroup = deps.signalGroup ?? defaultSignalGroup
  try {
    signalGroup(identity.pgid, 0)
  } catch (error) {
    // EPERM: the group exists but is not this user's, so it is not ours.
    return isErrnoCode(error, 'ESRCH') ? 'absent' : 'refused'
  }
  const leader = await (deps.readProcessRow ?? readPosixProcessRow)(identity.pgid)
  if (leader === 'unverifiable') {
    return 'refused'
  }
  // A leaderless group is still ours: POSIX never reuses a pid while a group of that id exists.
  // The recorded start predates its read's second, so a later reuse cannot share it.
  if (leader && (leader.pgid !== identity.pgid || leader.startedAt !== identity.startedAt)) {
    return 'refused'
  }
  try {
    signalGroup(identity.pgid, 'SIGKILL')
  } catch (error) {
    return isErrnoCode(error, 'ESRCH') ? 'absent' : 'refused'
  }
  recordSelfInitiatedTreeKill({
    pid: identity.pgid,
    site: deps.site,
    scope: 'posix-process-group'
  })
  return 'killed'
}

/**
 * Reads the group a supervisor reports on its IPC channel, proves it by the leader's parent and
 * start time, and sweeps that group once the supervisor exits. A no-op without the channel.
 */
export function guardSupervisedProviderGroup(
  child: GuardedChild,
  deps: ProviderGroupGuardDeps
): void {
  const supervisorPid = child.pid
  if (!supervisorPid || !hasReportChannel(child)) {
    return
  }
  let identity: Promise<ProviderGroupIdentity | null> = Promise.resolve(null)
  const reportEnded = new Promise<void>((resolve) => child.once('disconnect', resolve))
  child.once('message', (message: unknown) => {
    const pgid = reportedGroup(message)
    if (pgid !== null) {
      identity = proveReportedGroup(pgid, supervisorPid, deps)
      void identity.then((proven) => proven && deps.onProven?.(proven))
    }
  })
  child.once('exit', () => {
    // Exit can be observed before the report is delivered.
    void Promise.race([reportEnded, delay(REPORT_END_WAIT_MS, undefined, { ref: false })])
      .then(() => identity)
      .then((proven) => (proven ? sweepOrphanedProviderGroup(proven, deps) : ('unproven' as const)))
      .then(deps.onSwept, () => deps.onSwept?.('refused'))
  })
}

/**
 * The leader's identity, read while this supervisor still parents it (so its pid was not reused).
 * lstart has one-second resolution, so a start in the read's own second is read again after that
 * second ends; otherwise a pid reused within that second would carry the same start time.
 */
async function proveReportedGroup(
  pgid: number,
  supervisorPid: number,
  deps: ProviderGroupGuardDeps
): Promise<ProviderGroupIdentity | null> {
  const readRow = deps.readProcessRow ?? readPosixProcessRow
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => delay(ms, undefined, { ref: false }))
  for (let attempt = 0; attempt < IDENTITY_READ_ATTEMPTS; attempt += 1) {
    // The boundary before ps starts, as the descendant sweep takes it.
    const capturedAtMs = now()
    const row = await readRow(pgid)
    if (!row || row === 'unverifiable' || row.ppid !== supervisorPid || row.pgid !== pgid) {
      return null
    }
    if (hasUnambiguousStartTime(row.startedAt, capturedAtMs)) {
      return { pgid, startedAt: row.startedAt }
    }
    await sleep(1_000 - (now() % 1_000) + SECOND_BOUNDARY_MARGIN_MS)
  }
  return null
}

function hasReportChannel(child: GuardedChild): boolean {
  try {
    return child.connected
  } catch {
    // A handle-less child can throw here; the guard must never fail the spawn it watches.
    return false
  }
}

function reportedGroup(message: unknown): number | null {
  const pgid =
    typeof message === 'object' && message !== null && 'pgid' in message ? message.pgid : null
  return typeof pgid === 'number' && Number.isSafeInteger(pgid) && pgid > 1 ? pgid : null
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
