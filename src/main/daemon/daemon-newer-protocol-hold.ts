import type { NewerDaemonHold, NewerDaemonReopenResult } from '../../shared/newer-daemon-hold'
import { coldRestorePayloadFromInfo } from './cold-restore-payload-cache'
import { getDaemonHistoryDir, getDaemonRuntimeDir } from './daemon-launch-paths'
import {
  classifyNewerProtocolDaemon,
  type NewerProtocolDaemon
} from './daemon-newer-protocol-discovery'
import { getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { killStaleDaemon } from './daemon-stale-kill'
import { HistoryReader } from './history-reader'

let heldProtocols: readonly number[] = []
let reopenInFlight: Promise<NewerDaemonReopenResult> | null = null

/** Records the newer daemons this launch must not duplicate; exited ones hold nothing. */
export function setNewerProtocolDaemons(daemons: readonly NewerProtocolDaemon[]): void {
  heldProtocols = daemons
    .filter((daemon) => daemon.verdict !== 'exited')
    .map((daemon) => daemon.protocolVersion)
}

export function isHoldingForNewerProtocolDaemon(): boolean {
  return heldProtocols.length > 0
}

/** The session's last saved screen, read from history without spawning, while a hold stands. */
export async function readNewerDaemonHold(
  sessionId: string,
  historyPath = getDaemonHistoryDir()
): Promise<NewerDaemonHold> {
  if (heldProtocols.length === 0) {
    return { held: false }
  }
  const restoreInfo = await new HistoryReader(historyPath)
    .detectColdRestore(sessionId)
    .catch(() => null)
  const payload = restoreInfo ? coldRestorePayloadFromInfo(restoreInfo) : null
  return {
    held: true,
    restoredScreen: payload
      ? { scrollback: payload.scrollback, cols: payload.cols, rows: payload.rows }
      : null
  }
}

/** Signals only a verified daemon; confirmed only once the same classifier reads it exited. */
async function stopNewerProtocolDaemon(
  runtimeDir: string,
  protocolVersion: number
): Promise<boolean> {
  const verdict = await classifyNewerProtocolDaemon(runtimeDir, protocolVersion)
  if (verdict !== 'live') {
    return verdict === 'exited'
  }
  const outcome = await killStaleDaemon(
    runtimeDir,
    getDaemonSocketPath(runtimeDir, protocolVersion),
    getDaemonTokenPath(runtimeDir, protocolVersion),
    protocolVersion
  )
  return (
    !outcome.liveOwnerSurvived &&
    (await classifyNewerProtocolDaemon(runtimeDir, protocolVersion)) === 'exited'
  )
}

/**
 * Stops every held newer daemon by signal only: this build cannot speak its protocol. Held
 * terminals are released only when every one is confirmed exited.
 */
export function reopenNewerDaemonTerminals(
  runtimeDir = getDaemonRuntimeDir()
): Promise<NewerDaemonReopenResult> {
  reopenInFlight ??= (async () => {
    try {
      const remaining: number[] = []
      for (const protocolVersion of heldProtocols) {
        if (!(await stopNewerProtocolDaemon(runtimeDir, protocolVersion))) {
          remaining.push(protocolVersion)
        }
      }
      heldProtocols = remaining
      return { reopened: remaining.length === 0 }
    } finally {
      reopenInFlight = null
    }
  })()
  return reopenInFlight
}
