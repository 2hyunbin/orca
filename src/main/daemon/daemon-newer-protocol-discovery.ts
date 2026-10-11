import { readdirSync, readFileSync } from 'node:fs'
import { probeDaemonSocket } from './daemon-launch-paths'
import { parseDaemonPidFile, salvagePidFromCorruptDaemonRecord } from './daemon-pid-file-parse'
import { inspectDaemonProcessIdentity } from './daemon-pid-identity'
import { inspectProcessSignal } from './daemon-process-inspection'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'

export type NewerProtocolDaemonVerdict = 'live' | 'unverifiable' | 'exited'

export type NewerProtocolDaemon = {
  protocolVersion: number
  verdict: NewerProtocolDaemonVerdict
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

const PID_FILE_PATTERN = /^daemon-v(\d+)\.pid$/

function listNewerProtocolVersions(runtimeDir: string): number[] {
  let names: string[]
  try {
    names = readdirSync(runtimeDir)
  } catch {
    return []
  }
  const versions: number[] = []
  for (const name of names) {
    const match = PID_FILE_PATTERN.exec(name)
    const version = match ? Number(match[1]) : Number.NaN
    if (Number.isSafeInteger(version) && version > PROTOCOL_VERSION) {
      versions.push(version)
    }
  }
  return versions.sort((a, b) => a - b)
}

async function classifyNewerProtocolDaemon(
  runtimeDir: string,
  protocolVersion: number
): Promise<NewerProtocolDaemonVerdict> {
  let contents: string
  try {
    contents = readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
  } catch (error) {
    // Why: a vanished record is the newer daemon's own exit cleanup; an unreadable one proves nothing.
    return hasErrorCode(error, 'ENOENT') ? 'exited' : 'unverifiable'
  }
  const parsed = parseDaemonPidFile(contents)
  // Why pid > 0: an empty record mid-publish parses as pid 0, which names no process.
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    const salvaged = salvagePidFromCorruptDaemonRecord(contents)
    if (salvaged === null) {
      return contents.trim() === '' ? 'unverifiable' : 'exited'
    }
    return inspectProcessSignal(salvaged) === 'missing' ? 'exited' : 'unverifiable'
  }
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const identity = await inspectDaemonProcessIdentity(
    parsed.pid,
    socketPath,
    getDaemonTokenPath(runtimeDir, protocolVersion),
    parsed.startedAtMs
  )
  if (identity === 'mismatch') {
    // Why exited: the pid is gone or now names another process, so that daemon is gone.
    return 'exited'
  }
  if (identity === 'unknown') {
    return 'unverifiable'
  }
  return (await probeDaemonSocket(socketPath)) ? 'live' : 'unverifiable'
}

/**
 * Daemons from a newer build in this profile's runtime dir. This build cannot speak their
 * protocol, so it only reads their PID records and never touches their files.
 */
export async function discoverNewerProtocolDaemons(
  runtimeDir: string
): Promise<NewerProtocolDaemon[]> {
  return Promise.all(
    listNewerProtocolVersions(runtimeDir).map(async (protocolVersion) => ({
      protocolVersion,
      verdict: await classifyNewerProtocolDaemon(runtimeDir, protocolVersion)
    }))
  )
}
