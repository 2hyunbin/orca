import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
import { legacyDaemonProcessMayBeAlive } from './daemon-legacy-process-liveness'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from './types'

export type SessionListingDaemon = {
  readonly protocolVersion: number
  listsSession(id: string): Promise<boolean | null>
}

/**
 * Whether any daemon sharing the history dir may still run the session. A daemon Orca holds no
 * adapter for (held for a newer protocol, or an older one whose socket failed) cannot answer, and
 * silence is never absence.
 */
export async function mayAnyDaemonRunSession(
  id: string,
  runtimeDir: string | null,
  daemons: readonly SessionListingDaemon[]
): Promise<boolean> {
  if (runtimeDir === null || isHoldingForNewerProtocolDaemon()) {
    return true
  }
  const asked = new Set(daemons.map((daemon) => daemon.protocolVersion))
  if (
    PREVIOUS_DAEMON_PROTOCOL_VERSIONS.some(
      (version) => !asked.has(version) && legacyDaemonProcessMayBeAlive(runtimeDir, version)
    )
  ) {
    return true
  }
  const listings = await Promise.all(daemons.map((daemon) => daemon.listsSession(id)))
  return listings.some((listed) => listed !== false)
}
