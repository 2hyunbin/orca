import { parseWslUncPath } from '../../shared/wsl-paths'
import { isWslDistroRunning, noteWslDistrosRunning } from '../wsl-background-distro-gate'

// Any 9P touch of `\\wsl.localhost\<distro>` boots a stopped distro, so background reads ask first.
// Stops are signalled (watcher or relay exit), so a running read is trusted this long without one,
// keeping wsl.exe spawns to about one a minute; a read started before a stop signal never counts.
export const WSL_UNC_RUNNING_LEASE_MS = 60_000

const mayHaveStoppedAt = new Map<string, number>()

export class WslDistroStoppedError extends Error {
  readonly code = 'WSL_DISTRO_STOPPED'

  constructor(readonly distro: string) {
    super(`WSL distro '${distro}' is not running. Retry, or open a terminal in it, to start it.`)
    this.name = 'WslDistroStoppedError'
  }
}

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

/** A link into the distro died; the next UNC touch needs a running read started after this. */
export function noteWslDistroMayHaveStopped(distro: string): void {
  mayHaveStoppedAt.set(distroKey(distro), performance.now())
}

async function isWslDistroRunningForUncAccess(distro: string): Promise<boolean> {
  const startedAfter = Math.max(
    mayHaveStoppedAt.get(distroKey(distro)) ?? -Infinity,
    performance.now() - WSL_UNC_RUNNING_LEASE_MS
  )
  return isWslDistroRunning(distro, { startedAfter })
}

/** The distro a touch of `path` (or Git run for it) would run in; null off Windows or for a host path. */
export function wslDistroForPath(path: string, wslDistro?: string | null): string | null {
  if (process.platform !== 'win32') {
    return null
  }
  return parseWslUncPath(path)?.distro ?? wslDistro ?? null
}

/**
 * The distro a background touch of `path` would boot, or null when the touch is safe. `wslDistro`
 * covers a non-UNC path whose Git still runs through `wsl.exe` in that distro.
 */
export async function stoppedWslDistroForPath(
  path: string,
  wslDistro?: string | null
): Promise<string | null> {
  const distro = wslDistroForPath(path, wslDistro)
  if (!distro || (await isWslDistroRunningForUncAccess(distro))) {
    return null
  }
  return distro
}

/**
 * Refuses a background touch of a stopped distro's UNC path. `wake` is a user act: it may boot the
 * distro, and its success proves the distro runs so work waiting on it resumes.
 */
export async function guardWslUncPathAccess<T>(
  path: string,
  access: () => Promise<T>,
  options: { wake?: boolean } = {}
): Promise<T> {
  if (options.wake) {
    const result = await access()
    const parsed = process.platform === 'win32' ? parseWslUncPath(path) : null
    if (parsed) {
      noteWslDistrosRunning([parsed.distro])
    }
    return result
  }
  await assertWslUncPathRunning(path)
  return access()
}

/** Throws WslDistroStoppedError when a background touch of `path` (or its Git) would boot a distro. */
export async function assertWslUncPathRunning(
  path: string,
  wslDistro?: string | null
): Promise<void> {
  const stopped = await stoppedWslDistroForPath(path, wslDistro)
  if (stopped) {
    throw new WslDistroStoppedError(stopped)
  }
}

export function _resetWslUncAccessGateForTests(): void {
  mayHaveStoppedAt.clear()
}
