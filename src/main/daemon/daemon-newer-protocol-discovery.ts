import { readdirSync, readFileSync } from 'node:fs'
import { endpointIsProvenDead, probeSocketConnect } from './daemon-endpoint-probe'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { inspectDaemonProcessIdentity } from './daemon-pid-identity'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'

export type NewerProtocolDaemon = {
  protocolVersion: number
  verdict: ProcessLivenessVerdict['status']
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

/**
 * Reads only the newer daemon's PID record and endpoint; this build cannot speak its protocol
 * and never touches its files. An unidentifiable owner falls back to the endpoint, the same
 * tiebreaker killStaleDaemon uses, so a dead leftover never holds a tab forever.
 */
export async function classifyNewerProtocolDaemon(
  runtimeDir: string,
  protocolVersion: number
): Promise<ProcessLivenessVerdict['status']> {
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const byEndpoint = async (): Promise<ProcessLivenessVerdict['status']> =>
    endpointIsProvenDead(await probeSocketConnect(socketPath)) ? 'exited' : 'unverifiable'
  let contents: string
  try {
    contents = readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
  } catch (error) {
    // Why: a daemon removes its own record as it exits.
    return hasErrorCode(error, 'ENOENT') ? 'exited' : byEndpoint()
  }
  const parsed = parseDaemonPidFile(contents)
  // Why pid > 0: an empty record parses as pid 0, which names no process.
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return byEndpoint()
  }
  const identity = await inspectDaemonProcessIdentity(
    parsed.pid,
    socketPath,
    getDaemonTokenPath(runtimeDir, protocolVersion),
    parsed.startedAtMs
  )
  if (identity === 'match') {
    return 'live'
  }
  // Why mismatch is exited: the pid is gone or now names another process.
  return identity === 'mismatch' ? 'exited' : byEndpoint()
}

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
