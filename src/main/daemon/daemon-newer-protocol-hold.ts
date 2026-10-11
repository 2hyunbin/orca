import { existsSync } from 'node:fs'
import type { NewerDaemonHold, NewerDaemonReopenResult } from '../../shared/newer-daemon-hold'
import { coldRestorePayloadFromInfo } from './cold-restore-payload-cache'
import { getDaemonHistoryDir } from './daemon-launch-paths'
import type { NewerProtocolDaemon } from './daemon-newer-protocol-discovery'
import { inspectDaemonProcessIdentity } from './daemon-pid-identity'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { listEveryDaemonGeneration, type DaemonProvider } from './daemon-provider-routing'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { killStaleDaemon } from './daemon-stale-kill'
import { HistoryReader } from './history-reader'

type HeldNewerDaemons = { runtimeDir: string; daemons: NewerProtocolDaemon[] }

let held: HeldNewerDaemons | null = null
let reopenInFlight: Promise<NewerDaemonReopenResult> | null = null

/** Records the newer daemons this launch must not duplicate; exited ones hold nothing. */
export function setNewerProtocolDaemons(
  runtimeDir: string,
  daemons: readonly NewerProtocolDaemon[]
): void {
  const holding = daemons.filter((daemon) => daemon.verdict !== 'exited')
  held = holding.length > 0 ? { runtimeDir, daemons: holding } : null
}

export function hasNewerProtocolDaemonHold(): boolean {
  return held !== null
}

/**
 * Held unless an adopted daemon proves it owns the session. An unanswered inventory holds too:
 * a wrong hold costs a click, a wrong release starts a second agent on the same conversation.
 */
export async function isSessionHeldByNewerDaemon(
  sessionId: string,
  provider: DaemonProvider | null
): Promise<boolean> {
  if (!held) {
    return false
  }
  const sessions = provider
    ? await listEveryDaemonGeneration(provider, (adapter) => adapter.listSessions()).catch(
        () => null
      )
    : null
  return !sessions?.some((session) => session.sessionId === sessionId)
}

/** The hold plus the session's last saved screen, read from history without spawning. */
export async function readNewerDaemonHold(
  sessionId: string,
  provider: DaemonProvider | null,
  historyPath = getDaemonHistoryDir()
): Promise<NewerDaemonHold> {
  if (!(await isSessionHeldByNewerDaemon(sessionId, provider))) {
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

/** Confirmed only when the recorded pid is gone or provably names another process. */
async function stopNewerProtocolDaemon(
  runtimeDir: string,
  protocolVersion: number
): Promise<boolean> {
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
  if (!existsSync(pidPath)) {
    // Why: a daemon removes its own record as it exits; discovery reads absence the same way.
    return true
  }
  const record = readDaemonPidRecord(pidPath)
  if (!record) {
    return false
  }
  const identify = () =>
    inspectDaemonProcessIdentity(record.pid, socketPath, tokenPath, record.startedAtMs)
  const before = await identify()
  if (before === 'mismatch') {
    return true
  }
  // Why: only a verified daemon may be signalled; an unidentified pid could be anything.
  if (before !== 'match') {
    return false
  }
  const outcome = await killStaleDaemon(runtimeDir, socketPath, tokenPath, protocolVersion)
  return !outcome.liveOwnerSurvived && (await identify()) === 'mismatch'
}

/**
 * Stops every held newer daemon by signal only: this build cannot speak its protocol. Held
 * terminals are released only when every one is confirmed exited.
 */
export function reopenNewerDaemonTerminals(): Promise<NewerDaemonReopenResult> {
  reopenInFlight ??= (async () => {
    try {
      const current = held
      if (!current) {
        return { reopened: true }
      }
      const remaining: NewerProtocolDaemon[] = []
      for (const daemon of current.daemons) {
        if (!(await stopNewerProtocolDaemon(current.runtimeDir, daemon.protocolVersion))) {
          remaining.push(daemon)
        }
      }
      held = remaining.length > 0 ? { runtimeDir: current.runtimeDir, daemons: remaining } : null
      return { reopened: held === null }
    } finally {
      reopenInFlight = null
    }
  })()
  return reopenInFlight
}
