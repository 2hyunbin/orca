import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'

// Why 5s: the daemon already calls an fs stat unanswered this long stalled and refuses terminal
// starts on it (DAEMON_ASYNC_IO_TIMEOUT_MS); a folder that answers sooner behaves as before.
export const LOCAL_FOLDER_STAT_TIMEOUT_MS = 5_000

/** The folder did not answer in time; it may still exist, so this is never "missing". */
export class LocalFolderStatTimeoutError extends Error {
  constructor(path: string) {
    super(`Folder "${path}" did not answer within ${LOCAL_FOLDER_STAT_TIMEOUT_MS}ms.`)
    this.name = 'LocalFolderStatTimeoutError'
  }
}

// Why shared: a hung stat pins a libuv thread until the mount answers, so retries join it.
const pendingStats = new Map<string, Promise<Stats>>()

/** Test seam: an unsettled stat would otherwise leak into the next test. */
export function _resetLocalFolderStatStateForTest(): void {
  pendingStats.clear()
}

function sharedStat(path: string): Promise<Stats> {
  const existing = pendingStats.get(path)
  if (existing) {
    return existing
  }
  const started = stat(path)
  pendingStats.set(path, started)
  const forget = (): void => {
    if (pendingStats.get(path) === started) {
      pendingStats.delete(path)
    }
  }
  void started.then(forget, forget)
  return started
}

/** `fs.stat` that rejects with LocalFolderStatTimeoutError when a dead mount never answers. */
export function statLocalFolderWithDeadline(path: string): Promise<Stats> {
  return new Promise<Stats>((resolve, reject) => {
    // Why a holder: a stat that never settles must not keep a timed-out caller reachable.
    let settle: { resolve: (stats: Stats) => void; reject: (error: unknown) => void } | null = {
      resolve,
      reject
    }
    const timer = setTimeout(() => {
      settle?.reject(new LocalFolderStatTimeoutError(path))
      settle = null
    }, LOCAL_FOLDER_STAT_TIMEOUT_MS)
    void sharedStat(path).then(
      (stats) => {
        clearTimeout(timer)
        settle?.resolve(stats)
        settle = null
      },
      (error: unknown) => {
        clearTimeout(timer)
        settle?.reject(error)
        settle = null
      }
    )
  })
}
