import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import { setTimeout as delay } from 'node:timers/promises'
import { captureDescendantSnapshot, hasUnambiguousStartTime } from '../pty-descendant-termination'
import { readPosixProcessRow, type ProviderProcessRow } from './provider-process-row-read'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import {
  PROVIDER_GROUP_REAP_TIMEOUT_MS,
  PROVIDER_SIGTERM_GRACE_MS
} from './provider-process-timing'

export type ProviderGroupMember = Pick<ProviderProcessRow, 'pid' | 'startedAt' | 'pgid'>

/** Only a live, directly parented root can add identities to an owned group. */
export async function captureProviderGroup(
  pgid: number,
  retryBirthSecond = true
): Promise<ProviderGroupMember[]> {
  const boundary = Date.now()
  const root = await readPosixProcessRow(pgid)
  if (!root || root === 'unverifiable' || root.ppid !== process.pid || root.pgid !== pgid) {
    return []
  }
  if (root.startResolution === 'second' && !hasUnambiguousStartTime(root.startedAt, boundary)) {
    if (!retryBirthSecond) {
      return []
    }
    await delay(1_050 - (Date.now() % 1_000))
    return captureProviderGroup(pgid, false)
  }
  const snapshot = await captureDescendantSnapshot(pgid)
  const rows =
    snapshot?.rootPgid === pgid ? snapshot.descendants.filter((row) => row.pgid === pgid) : []
  const members = [root, ...rows]
  const qualified: ProviderGroupMember[] = []
  for (const member of members) {
    const fresh = await readPosixProcessRow(member.pid)
    if (!fresh || fresh === 'unverifiable' || fresh.pgid !== member.pgid) {
      continue
    }
    // ps snapshots and /proc ticks have different formats; compare each using its own reader.
    if (member.pid === pgid && fresh.startedAt !== root.startedAt) {
      continue
    }
    if (member.pid !== pgid) {
      if (!snapshot || !hasUnambiguousStartTime(member.startedAt, snapshot.capturedAtMs)) {
        continue
      }
      const started = await readProcessStartTimeMs(member.pid)
      if (
        started === null ||
        Math.floor(started / 1_000) * 1_000 !== Date.parse(member.startedAt)
      ) {
        continue
      }
    }
    if (fresh.startResolution === 'second' && !hasUnambiguousStartTime(fresh.startedAt, boundary)) {
      continue
    }
    const stillRoot = await readPosixProcessRow(pgid)
    if (
      !stillRoot ||
      stillRoot === 'unverifiable' ||
      stillRoot.startedAt !== root.startedAt ||
      stillRoot.ppid !== process.pid
    ) {
      break
    }
    qualified.push(fresh)
  }
  return qualified
}

export function providerGroupVerdict(pgid: number): DescendantTreeVerdict {
  try {
    process.kill(-pgid, 0)
    return 'live'
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
      ? 'exited'
      : 'unverifiable'
  }
}

export async function matchProviderGroupMember(
  members: readonly ProviderGroupMember[],
  pgid: number
): Promise<boolean> {
  for (const member of members) {
    const row = await readPosixProcessRow(member.pid)
    if (
      member.pgid === pgid &&
      row &&
      row !== 'unverifiable' &&
      row.startedAt === member.startedAt &&
      row.pgid === pgid
    ) {
      return true
    }
  }
  return false
}

/** A signal is delivery, never evidence of disappearance. */
export function signalProviderGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    /* A fresh probe supplies the verdict. */
  }
}

export async function observeProviderGroup(
  pgid: number,
  timeoutMs: number
): Promise<DescendantTreeVerdict> {
  const deadline = Date.now() + timeoutMs
  let verdict = providerGroupVerdict(pgid)
  while (verdict === 'live' && Date.now() < deadline) {
    await delay(Math.min(50, deadline - Date.now()))
    verdict = providerGroupVerdict(pgid)
  }
  return verdict
}

/** Revalidate a recorded member before every delayed escalation; never revive an empty group. */
export async function stopRecordedProviderGroup(
  pgid: number,
  members: readonly ProviderGroupMember[],
  owns: () => Promise<boolean> = async () => true,
  termSent = false
): Promise<DescendantTreeVerdict> {
  if (providerGroupVerdict(pgid) === 'exited') {
    return 'exited'
  }
  if (!termSent) {
    if (!(await owns()) || !(await matchProviderGroupMember(members, pgid))) {
      return 'unverifiable'
    }
    signalProviderGroup(pgid, 'SIGTERM')
  }
  const verdict = await observeProviderGroup(pgid, PROVIDER_SIGTERM_GRACE_MS)
  if (verdict === 'exited') {
    return verdict
  }
  if (!(await owns()) || !(await matchProviderGroupMember(members, pgid))) {
    return 'unverifiable'
  }
  signalProviderGroup(pgid, 'SIGKILL')
  return observeProviderGroup(pgid, PROVIDER_GROUP_REAP_TIMEOUT_MS)
}
