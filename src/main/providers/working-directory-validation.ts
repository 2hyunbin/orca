// Validates a PTY working directory before spawn, so node-pty cannot fail with
// an opaque ENOENT. Split from local-pty-utils to keep that file under its line
// cap; the async path carries the cancellation contract described below.

import { existsSync, statSync, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { release } from 'node:os'
import { isWslUncPath, uncRouteKey } from '../../shared/wsl-paths'
import { wslUncDirectoryExistsAsync } from '../wsl'
import { PrioritySemaphore } from '../../shared/priority-semaphore'

const pendingWorkingDirectoryValidations = new Map<string, Promise<void>>()
const pendingLocalFolderStats = new Map<string, Promise<Stats>>()
// Why 5s: the daemon already calls an fs stat unanswered this long stalled and refuses terminal
// starts on it (DAEMON_ASYNC_IO_TIMEOUT_MS); a folder that answers sooner behaves as before.
export const LOCAL_FOLDER_CHECK_TIMEOUT_MS = 5_000
// Why: a dead UNC share answers `stat` in ~21s on Windows and holds one of
// libuv's 4 default fs threads the whole time, so a handful of distinct paths on
// one unreachable server would starve every other async fs read in the daemon —
// moving the head-of-line stall off the event loop and into the thread pool.
// Matches the per-distro lane in rate-limits/auth-filesystem-operation.ts.
const MAX_CONCURRENT_UNC_VALIDATIONS = 2

type UncRouteLane = {
  readonly semaphore: PrioritySemaphore
  waiters: number
}

const uncRouteLanes = new Map<string, UncRouteLane>()

export { uncRouteKey } from '../../shared/wsl-paths'

async function withUncRouteLane<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const key = uncRouteKey(cwd)
  if (key === null) {
    return run()
  }
  let lane = uncRouteLanes.get(key)
  if (!lane) {
    lane = { semaphore: new PrioritySemaphore(MAX_CONCURRENT_UNC_VALIDATIONS), waiters: 0 }
    uncRouteLanes.set(key, lane)
  }
  // Counted before acquiring so a queued caller keeps the lane alive.
  lane.waiters += 1
  const release = await lane.semaphore.acquire(0)
  try {
    return await run()
  } finally {
    release()
    lane.waiters -= 1
    if (lane.waiters === 0) {
      uncRouteLanes.delete(key)
    }
  }
}

/** Thrown when the caller gave up on a probe that is still running. */
export class WorkingDirectoryValidationAbortedError extends Error {
  constructor(cwd: string) {
    super(`Working directory validation for "${cwd}" was canceled.`)
    this.name = 'WorkingDirectoryValidationAbortedError'
  }
}

/** Test seam: both maps are module-level, so an unsettled probe would leak across tests. */
export function _resetWorkingDirectoryValidationStateForTest(): void {
  pendingWorkingDirectoryValidations.clear()
  pendingLocalFolderStats.clear()
  uncRouteLanes.clear()
}

export function formatLocalPtyEnvironmentDiag(extra: Record<string, string> = {}): string {
  const systemVersion =
    (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion?.() ||
    release()
  const parts = {
    ...extra,
    arch: process.arch,
    platform: `${process.platform} ${systemVersion}`,
    orca: process.env.ORCA_APP_VERSION?.trim() || '0.0.0-dev'
  }
  return Object.entries(parts)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ')
}

function throwMissingWorkingDirectory(cwd: string): never {
  throw new Error(
    `Working directory "${cwd}" does not exist. ` +
      `It may have been deleted or is on an unmounted volume ` +
      `(${formatLocalPtyEnvironmentDiag({ cwd })}).`
  )
}

/**
 * Validate that a working directory exists and is a directory.
 * Rejects with a descriptive Error if not.
 */
export async function validateWorkingDirectory(cwd: string, signal?: AbortSignal): Promise<void> {
  // Why: the distro probe spawns wsl.exe (~70 ms warm, 300+ ms for a stopped
  // distro), so it must never run synchronously on the main process.
  if (isWslUncPath(cwd)) {
    return validateWorkingDirectoryAsync(cwd, { signal })
  }

  if (!existsSync(cwd)) {
    throwMissingWorkingDirectory(cwd)
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Working directory "${cwd}" is not a directory.`)
  }
}

/**
 * Validate a cwd without blocking the daemon's shared event loop.
 *
 * `fs.stat` takes no AbortSignal and a dead SMB/NFS mount can hang it for
 * minutes, so an aborted caller abandons the shared probe rather than
 * interrupting it: the probe stays shared for whoever is still waiting, and the
 * caller stops holding a create in flight.
 */
export function validateWorkingDirectoryAsync(
  cwd: string,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const key = cwd
  let validation = pendingWorkingDirectoryValidations.get(key)
  if (!validation) {
    validation = validateWorkingDirectoryUncached(cwd)
    pendingWorkingDirectoryValidations.set(key, validation)
    const started = validation
    // Why: dropped only on settle. `fs.stat` is uninterruptible, so retiring a
    // still-running probe on a timer frees no libuv thread — it only lets the
    // next caller pin a second one. Callers escape through `signal` instead, so
    // sharing one hung probe no longer strands them, and the route lane below
    // caps how many distinct paths on one dead host can block at once.
    const forget = (): void => {
      if (pendingWorkingDirectoryValidations.get(key) === started) {
        pendingWorkingDirectoryValidations.delete(key)
      }
    }
    void validation.then(forget, forget)
  }
  const signal = options.signal
  if (!signal) {
    return validation
  }
  return waitForWorkingDirectoryValidation(validation, cwd, signal)
}

/**
 * `fs.stat` for a local folder check that gives up after LOCAL_FOLDER_CHECK_TIMEOUT_MS, rejecting
 * with WorkingDirectoryValidationAbortedError. Shares one in-flight stat per path and the UNC route
 * lane, the same way validation does, so a retry on a dead mount pins no extra fs thread.
 */
export function statLocalFolderWithDeadline(path: string): Promise<Stats> {
  let pending = pendingLocalFolderStats.get(path)
  if (!pending) {
    const started = withUncRouteLane(path, () => stat(path))
    pending = started
    pendingLocalFolderStats.set(path, started)
    const forget = (): void => {
      if (pendingLocalFolderStats.get(path) === started) {
        pendingLocalFolderStats.delete(path)
      }
    }
    void started.then(forget, forget)
  }
  // Why a plain timer: unlike AbortSignal.timeout, it is cleared as soon as the stat settles.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), LOCAL_FOLDER_CHECK_TIMEOUT_MS)
  return waitForWorkingDirectoryValidation(pending, path, deadline.signal).finally(() =>
    clearTimeout(timer)
  )
}

function validateWorkingDirectoryUncached(cwd: string): Promise<void> {
  return withUncRouteLane(cwd, () => probeWorkingDirectory(cwd))
}

async function probeWorkingDirectory(cwd: string): Promise<void> {
  // Why: Win32 stat against the WSL 9P share (\\wsl.localhost\...) can falsely
  // report ENOENT for directories that exist on the Linux side. Ask the distro
  // itself; only fall back to the fs check when wsl.exe is inconclusive.
  if (isWslUncPath(cwd)) {
    const existsInDistro = await wslUncDirectoryExistsAsync(cwd)
    if (existsInDistro === false) {
      throwMissingWorkingDirectory(cwd)
    }
    if (existsInDistro === true) {
      return
    }
  }

  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(cwd)
  } catch {
    // One stat avoids paying an unreachable filesystem timeout twice.
    throwMissingWorkingDirectory(cwd)
  }
  if (!stats.isDirectory()) {
    throw new Error(`Working directory "${cwd}" is not a directory.`)
  }
}

type WorkingDirectoryWaiterHolder<T> = {
  waiter: {
    signal: AbortSignal
    onAbort: () => void
    resolve: (value: T) => void
    reject: (error: unknown) => void
  } | null
}

function takeWorkingDirectoryWaiter<T>(
  holder: WorkingDirectoryWaiterHolder<T>
): WorkingDirectoryWaiterHolder<T>['waiter'] {
  const waiter = holder.waiter
  holder.waiter = null
  waiter?.signal.removeEventListener('abort', waiter.onAbort)
  return waiter
}

// Keep reaction order while an abandoned caller's signal and resolver become collectible.
function observeWorkingDirectoryValidation<T>(
  promise: Promise<T>,
  holder: WorkingDirectoryWaiterHolder<T>
): void {
  void promise.then(
    (value) => takeWorkingDirectoryWaiter(holder)?.resolve(value),
    (error: unknown) => takeWorkingDirectoryWaiter(holder)?.reject(error)
  )
}

function waitForWorkingDirectoryValidation<T>(
  shared: Promise<T>,
  cwd: string,
  signal: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const holder: WorkingDirectoryWaiterHolder<T> = { waiter: null }
    const onAbort = (): void => {
      takeWorkingDirectoryWaiter(holder)?.reject(new WorkingDirectoryValidationAbortedError(cwd))
    }
    holder.waiter = { signal, onAbort, resolve, reject }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    observeWorkingDirectoryValidation(shared, holder)
  })
}
