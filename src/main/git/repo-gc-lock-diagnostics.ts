import { readFile, stat, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { GC_LOG_STALE_MS, GC_PID_STALE_MS } from '../../shared/repo-object-maintenance-policy'

export type GcPidState = 'absent' | 'live' | 'stale'

export type RepoGcLockDiagnostics = {
  gcPid: GcPidState
  /** Size of a gc.log old enough that Git refuses auto-gc because of it; never deleted. */
  staleGcLogBytes: number
  removedStaleGcLogLock: boolean
}

type Inspection = {
  /** False when pids belong to another kernel (WSL from Windows), so only age is evidence. */
  canProbePids: boolean
  now?: number
}

async function statIfPresent(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

/** Mirrors Git: gc.pid is stale past 12h, or when its pid is dead on this same host. */
async function readGcPidState(
  path: string,
  inspection: Inspection,
  now: number
): Promise<GcPidState> {
  const info = await statIfPresent(path)
  if (!info) {
    return 'absent'
  }
  if (now - info.mtimeMs > GC_PID_STALE_MS) {
    return 'stale'
  }
  const content = await readFile(path, 'utf8').catch(() => '')
  const [pidText, host] = content.trim().split(/\s+/, 2)
  const pid = Number(pidText)
  if (!inspection.canProbePids || !Number.isSafeInteger(pid) || pid <= 0 || host !== hostname()) {
    return 'live'
  }
  return isPidAlive(pid) ? 'live' : 'stale'
}

/**
 * Report gc state that blocks Git's own housekeeping. A gc.log.lock older than a day with no
 * live gc is a strand from a crashed gc and blocks every later auto-gc, so it is removed;
 * gc.log is the only record of why gc failed and is left for the user.
 */
export async function inspectRepoGcLocks(
  commonDir: string,
  inspection: Inspection
): Promise<RepoGcLockDiagnostics> {
  const paths = isWindowsAbsolutePathLike(commonDir) ? win32 : posix
  const now = inspection.now ?? Date.now()
  const gcPid = await readGcPidState(paths.join(commonDir, 'gc.pid'), inspection, now)
  const logPath = paths.join(commonDir, 'gc.log')
  const log = await statIfPresent(logPath)
  const staleGcLogBytes = log && log.size > 0 && now - log.mtimeMs > GC_LOG_STALE_MS ? log.size : 0
  if (staleGcLogBytes > 0) {
    console.warn(
      `[repo-object-maintenance] ${logPath} reports a failed gc (${staleGcLogBytes} bytes)`
    )
  }
  const lockPath = paths.join(commonDir, 'gc.log.lock')
  const lock = await statIfPresent(lockPath)
  let removedStaleGcLogLock = false
  if (lock && gcPid !== 'live' && now - lock.mtimeMs > GC_LOG_STALE_MS) {
    try {
      const preview = (await readFile(lockPath, 'utf8').catch(() => '')).trim().slice(0, 300)
      await unlink(lockPath)
      removedStaleGcLogLock = true
      console.warn(`[repo-object-maintenance] removed stale ${lockPath}`, preview)
    } catch (error) {
      console.warn(`[repo-object-maintenance] could not remove stale ${lockPath}:`, error)
    }
  }
  return { gcPid, staleGcLogBytes, removedStaleGcLogLock }
}
