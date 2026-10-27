import { readFileSync } from 'node:fs'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { getDaemonPidPath } from './daemon-spawner'

/** An older-protocol daemon's pid file names a process that still exists (it may be alive). */
export function legacyDaemonProcessMayBeAlive(
  runtimeDir: string,
  protocolVersion: number
): boolean {
  try {
    const parsed = parseDaemonPidFile(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
    if (!parsed) {
      return false
    }
    process.kill(parsed.pid, 0)
    return true
  } catch {
    return false
  }
}
