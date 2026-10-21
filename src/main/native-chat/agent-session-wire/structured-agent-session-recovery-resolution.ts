import {
  captureDescendantSnapshot,
  hasUnambiguousStartTime,
  hasUnambiguousStartIdentity
} from '../../pty-descendant-termination'
import { terminateDescendantSnapshotWithVerdict } from '../../pty-descendant-exit-verification'
import { readProcessStartTimeMs } from '../../runtime/agent-session-process-identity-probe'
import { readPosixProcessRow } from '../../provider-process/provider-process-row-read'
import {
  hasRecordedProviderLaunch,
  recoverProviderLaunches
} from '../../provider-process/provider-process-ledger'
/**
 * Exits from the `recovering` stage. A session lands there when evidence about its owner was
 * unavailable; this re-asks with present-time evidence and always concludes. A dead owner is
 * evicted on proof. A live one is stopped by identity and evicted once
 * proven gone. One that outlives the stop, or whose identity cannot be verified, is released
 * anyway: its transport died with the runtime that held it, so nothing can drive it, and no signal
 * is sent to a pid that cannot be verified as the one recorded. Windows never signals a saved pid
 * at all: Orca stops a Windows tree only through a child it still holds. Only a conflicted claim,
 * which is how a terminal owner an older build recorded now loads, is waited out and never
 * stopped: it is the user's own agent, and its exit is its way out.
 */

import {
  isProvenAliveProbe,
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../provider-process/provider-process-timing'
import { releaseUnprovenAgentSessionOwner } from '../../runtime/agent-session-lease-transitions'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

export type StructuredSessionRecoveryStopSignal = 'SIGTERM' | 'SIGKILL'

export type StructuredSessionRecoveryResolutionDeps = {
  store: AgentSessionRecordStore
  probeRecord: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  now: () => number
  stopOwnerProcess?: (pid: number, signal: StructuredSessionRecoveryStopSignal) => void
  delay?: (ms: number) => Promise<void>
  platform?: NodeJS.Platform
}

const STOP_PROBE_INTERVAL_MS = 250
// POSIX only: Windows never signals a recorded owner. The owner is its provider supervisor, which
// exits only after its provider group. A SIGKILL that lands first leaves the group running, so
// SIGTERM outlasts its stop.
const STOP_PROBES: Record<StructuredSessionRecoveryStopSignal, number> = {
  SIGTERM: Math.ceil(PROVIDER_SUPERVISOR_MAX_STOP_MS / STOP_PROBE_INTERVAL_MS) + 1,
  SIGKILL: 4
}

const UNRESOLVED_REFUSALS: ReadonlySet<string> = new Set([
  'agent_session_ownership_unknown',
  'agent_session_checkpoint_stale',
  'execution_owner_reconciling',
  'agent_session_identity_required'
])

export async function resolveStructuredSessionRecovery(
  deps: StructuredSessionRecoveryResolutionDeps,
  sessionId: string
): Promise<'resolved' | 'unresolved' | 'not-applicable'> {
  const record = deps.store.getRecord(sessionId)
  if (record?.lease.handoffStage !== 'recovering') {
    return 'not-applicable'
  }
  await cleanUpStructuredSessionOwner(deps, record)
  const probe = await deps.probeRecord(record)
  const owner = record.lease.ownerProcess
  if (owner && record.lease.claimStatus === 'conflicted' && !isProvenDeadProbe(probe)) {
    // A terminal agent keeps its transport across a restart, so only proof of its exit is a way in.
    return 'unresolved'
  }
  try {
    await (owner && !isProvenDeadProbe(probe)
      ? deps.store.transitionHandoff(sessionId, (latest) =>
          releaseUnprovenAgentSessionOwner({
            record: latest,
            expectedFence: record.lease.runtimeFence,
            now: deps.now()
          })
        )
      : deps.store.evictProvenDeadOwner({
          sessionId,
          expectedFence: record.lease.runtimeFence,
          probe,
          now: deps.now()
        }))
    return 'resolved'
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error)
    if (UNRESOLVED_REFUSALS.has(code)) {
      // The record moved under this resolution; the next attempt re-asks against what it is now.
      return 'unresolved'
    }
    throw error
  }
}

/** Runs before adjudication can discard the only old-supervisor identity. */
export async function cleanUpStructuredSessionOwner(
  deps: StructuredSessionRecoveryResolutionDeps,
  record: AgentSessionRecord
): Promise<void> {
  if ((deps.platform ?? process.platform) === 'win32') {
    return
  }
  await recoverProviderLaunches()
  const owner = record.lease.ownerProcess
  if (!owner || owner.hostId !== deps.store.hostId || record.lease.claimStatus === 'conflicted') {
    return
  }
  if (await hasRecordedProviderLaunch(owner.pid)) {
    return
  }
  if (!isProvenAliveProbe(await deps.probeRecord(record))) {
    return
  }
  const matches = async (): Promise<boolean> => {
    if (!leaseStillNamesOwner(deps.store.getRecord(record.sessionId), record)) {
      return false
    }
    const boundary = Date.now()
    const row = await readPosixProcessRow(owner.pid)
    if (
      !row ||
      row === 'unverifiable' ||
      (row.startResolution === 'second' && !hasUnambiguousStartTime(row.startedAt, boundary))
    ) {
      return false
    }
    return (await readProcessStartTimeMs(owner.pid)) === owner.processStartTimeMs
  }
  if (!(await matches())) {
    return
  }
  const captured = await captureDescendantSnapshot(owner.pid)
  if (!(await matches())) {
    return
  }
  const snapshot = captured && {
    ...captured,
    descendants: captured.descendants.filter((row) =>
      hasUnambiguousStartIdentity(
        row,
        captured.capturedAtMsByPid?.[String(row.pid)] ?? captured.capturedAtMs
      )
    )
  }
  const stop = deps.stopOwnerProcess ?? defaultStopOwnerProcess
  const delay =
    deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  stopLadder: for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!(await matches())) {
      break
    }
    stop(owner.pid, signal)
    for (let attempt = 0; attempt < STOP_PROBES[signal]; attempt += 1) {
      const probe = await deps.probeRecord(record)
      if (isProvenDeadProbe(probe)) {
        break stopLadder
      }
      await delay(STOP_PROBE_INTERVAL_MS)
    }
  }
  if (snapshot && leaseStillNamesOwner(deps.store.getRecord(record.sessionId), record)) {
    await terminateDescendantSnapshotWithVerdict(snapshot, {
      requireIdentityBeforeSignal: true,
      sendSignal: (pid, signal) => {
        if (
          (signal === 'SIGTERM' || signal === 'SIGKILL') &&
          leaseStillNamesOwner(deps.store.getRecord(record.sessionId), record)
        ) {
          stop(pid, signal)
        }
      }
    })
  }
}

function leaseStillNamesOwner(
  current: AgentSessionRecord | null,
  probed: AgentSessionRecord
): boolean {
  const owner = current?.lease.ownerProcess
  const expected = probed.lease.ownerProcess
  return (
    current?.lease.runtimeFence === probed.lease.runtimeFence &&
    current?.lease.claimKeyId === probed.lease.claimKeyId &&
    current?.lease.claimStatus === probed.lease.claimStatus &&
    current?.lease.reservedSpawnToken === probed.lease.reservedSpawnToken &&
    owner?.hostId === expected?.hostId &&
    owner?.spawnToken === expected?.spawnToken &&
    owner?.pid === expected?.pid &&
    owner?.processStartTimeMs === expected?.processStartTimeMs
  )
}

function defaultStopOwnerProcess(pid: number, signal: StructuredSessionRecoveryStopSignal): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone or not ours to signal; the next probe supplies the actual proof.
  }
}
