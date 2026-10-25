import { readFile, stat, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { posix, win32 } from 'node:path'
import { runProcess } from '@orca/process-host'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import {
  isGitMaintenanceCommandLine,
  isStaleMaintenanceLock,
  MAINTENANCE_LOCK_STALE_MS
} from '../../shared/repo-object-maintenance-policy'

const PROCESS_LIST_TIMEOUT_MS = 15_000
const PROCESS_LIST_MAX_BYTES = 16 * 1024 * 1024
/** gc.log is never touched: it is the only record of why a gc failed. */
const LOCK_FILES = [['objects', 'maintenance.lock'], ['gc.pid'], ['gc.log.lock']] as const

async function listProcessCommandLines(): Promise<string[]> {
  const result =
    process.platform === 'win32'
      ? await runProcess({
          program: 'powershell.exe',
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process -Filter "Name LIKE \'git%\'" | ForEach-Object { $_.CommandLine }'
          ],
          timeoutMs: PROCESS_LIST_TIMEOUT_MS,
          maxOutputBytes: PROCESS_LIST_MAX_BYTES
        })
      : await runProcess({
          program: 'ps',
          args: ['-A', '-o', 'args='],
          timeoutMs: PROCESS_LIST_TIMEOUT_MS,
          maxOutputBytes: PROCESS_LIST_MAX_BYTES
        })
  if (result.timedOut || result.code !== 0) {
    throw new Error(`process list exited ${result.code ?? 'on timeout'}`)
  }
  return result.stdout.split(/\r?\n/)
}

async function isGitMaintenanceRunning(): Promise<boolean> {
  try {
    return (await listProcessCommandLines()).some(isGitMaintenanceCommandLine)
  } catch (error) {
    console.warn('[repo-object-maintenance] could not list processes; keeping locks', error)
    return true
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

/** Git writes `<pid> <host>`; like Git, an unparseable file holds nothing. */
async function isGcPidLive(path: string): Promise<boolean> {
  const content = await readFile(path, 'utf8').catch(() => '')
  const [pidText, host] = content.trim().split(/\s+/, 2)
  const pid = Number(pidText)
  return Number.isSafeInteger(pid) && pid > 0 && host === hostname() && isPidAlive(pid)
}

export type MaintenanceLockState = {
  removed: string[]
  /** `objects/maintenance.lock` still exists, so `git maintenance run` would silently no-op. */
  maintenanceLockHeld: boolean
}

/**
 * Remove gc and maintenance locks a crashed or killed run left behind. `canInspectProcesses`
 * is false when Git runs under another kernel (WSL from Windows): its processes are invisible.
 */
export async function removeStaleMaintenanceLocks(
  commonDir: string,
  options: { canInspectProcesses: boolean; now?: number }
): Promise<MaintenanceLockState> {
  const paths = isWindowsAbsolutePathLike(commonDir) ? win32 : posix
  const now = options.now ?? Date.now()
  const present = (
    await Promise.all(
      LOCK_FILES.map(async (segments) => {
        const path = paths.join(commonDir, ...segments)
        const info = await stat(path).catch(() => null)
        return info ? { path, ageMs: now - info.mtimeMs } : null
      })
    )
  ).filter((lock) => lock !== null)
  const maintenanceLock = paths.join(commonDir, 'objects', 'maintenance.lock')
  const candidates = present.filter((lock) => lock.ageMs > MAINTENANCE_LOCK_STALE_MS)
  const removed: string[] = []
  if (candidates.length > 0 && options.canInspectProcesses) {
    const gitMaintenanceRunning = await isGitMaintenanceRunning()
    for (const lock of candidates) {
      const gcPidLive = lock.path.endsWith('gc.pid') ? await isGcPidLive(lock.path) : undefined
      if (!isStaleMaintenanceLock({ ageMs: lock.ageMs, gitMaintenanceRunning, gcPidLive })) {
        continue
      }
      try {
        await unlink(lock.path)
        removed.push(lock.path)
        console.warn(
          `[repo-object-maintenance] removed stale ${lock.path} (${Math.round(lock.ageMs / 3_600_000)}h old)`
        )
      } catch (error) {
        console.warn(`[repo-object-maintenance] could not remove stale ${lock.path}:`, error)
      }
    }
  }
  return {
    removed,
    maintenanceLockHeld: present.some(
      (lock) => lock.path === maintenanceLock && !removed.includes(lock.path)
    )
  }
}
