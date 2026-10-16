/**
 * Teardown for integration tests whose orcad started a real terminal daemon in a temp profile.
 *
 * The daemon outlives orcad by design and only its pid record names it. Killing it is not
 * enough: until it has exited it can still remove its socket, pid and token files and append
 * to its log, so a recursive delete racing it fails with ENOTEMPTY (seen on macOS).
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { readDaemonPidRecord } from '../daemon/daemon-endpoint-incarnation'
import { cleanupDaemonForProtocol } from '../daemon/daemon-protocol-cleanup'
import type { spawnProcess } from '@orca/process-host'

const EXIT_WAIT_MS = 10_000
const POLL_MS = 50
const REMOVE_ATTEMPTS = 8
const REMOVE_RETRY_MS = 150

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms))

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

function hasExited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM still proves the process exists.
    return errorCode(error) === 'ESRCH'
  }
}

/** Waits, bounded, until the OS no longer knows every pid. */
export async function waitForProcessExit(pids: Iterable<number>): Promise<void> {
  const pending = [...pids]
  const deadline = Date.now() + EXIT_WAIT_MS
  while (pending.some((pid) => !hasExited(pid)) && Date.now() < deadline) {
    await sleep(POLL_MS)
  }
  const remaining = pending.filter((pid) => !hasExited(pid))
  if (remaining.length > 0) {
    throw new Error(`Processes did not exit: ${remaining.join(', ')}`)
  }
}

/** SIGKILLs each pid and requires the OS to confirm its exit. */
export async function killAndAwaitExit(pids: Iterable<number>): Promise<void> {
  const pending = [...pids]
  for (const pid of pending) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  await waitForProcessExit(pending)
}

/** Kills a spawned child and waits for its exit event. */
export async function killChildAndWait(child: ReturnType<typeof spawnProcess>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const exited = new Promise((settle) => child.once('exit', settle))
  child.kill('SIGKILL')
  await exited
}

/** Authenticates each profile daemon, shuts down its PTYs, and requires process exit. */
export async function killProfileDaemons(userData: string): Promise<void> {
  const daemonDir = join(userData, 'daemon')
  const daemons = (existsSync(daemonDir) ? readdirSync(daemonDir) : []).flatMap((name) => {
    const match = /^daemon-v(\d+)\.pid$/u.exec(name)
    const pid = match ? readDaemonPidRecord(join(daemonDir, name))?.pid : undefined
    return pid && match ? [{ pid, protocolVersion: Number(match[1]) }] : []
  })
  const results = await Promise.allSettled(
    daemons.map(async ({ pid, protocolVersion }) => {
      await cleanupDaemonForProtocol(daemonDir, protocolVersion, pid)
      await waitForProcessExit([pid])
    })
  )
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Profile daemon shutdown incomplete')
  }
}

/** Removes a test root, retrying a late writer's ENOTEMPTY/EBUSY on every platform. */
export async function removeTestRoot(root: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await removeTree(root)
      return
    } catch (error) {
      if (
        attempt >= REMOVE_ATTEMPTS ||
        !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(errorCode(error) ?? '')
      ) {
        throw error
      }
      await sleep(REMOVE_RETRY_MS)
    }
  }
}
