/**
 * Restores terminal admission after a returning client cancels an idle stop.
 *
 * Once the daemon accepts idle retirement, or may have accepted it, it never admits a terminal
 * again, so a server that stays up must replace it. A replacement ends whatever the old daemon
 * still runs, so it happens only when that is provably nothing.
 */
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { OrcadDaemonRetirement } from './orcad-daemon-retirement'
import { ORCAD_DAEMON_RETIREMENT_TIMEOUT_MS } from './orcad-stop-deadlines'

export type OrcadIdleStopDaemonRecoveryPorts = {
  admissionClosed: () => boolean
  countLiveSessions: () => Promise<number | null>
  replaceDaemon: () => Promise<unknown>
  timeoutMs?: number
}

/** `serving` when new terminals can start; `unservable` when this server cannot run any. */
export async function recoverDaemonAfterCancelledIdleStop(
  outcome: Pick<OrcadDaemonRetirement, 'retirement' | 'lateRetirement'>,
  ports: OrcadIdleStopDaemonRecoveryPorts
): Promise<'serving' | 'unservable'> {
  const timeoutMs = ports.timeoutMs ?? ORCAD_DAEMON_RETIREMENT_TIMEOUT_MS
  const retired =
    outcome.retirement === 'retired' ||
    (outcome.lateRetirement !== undefined &&
      (await withTimeout(outcome.lateRetirement, timeoutMs, false)))
  if (!retired) {
    if (!ports.admissionClosed()) {
      return 'serving'
    }
    // The stop request may have landed with its reply lost: replace only an empty daemon.
    const live = await withTimeout(ports.countLiveSessions(), timeoutMs, null)
    if (live !== 0) {
      console.error('[orcad] the terminal daemon may be retiring and could not be proven empty')
      return 'unservable'
    }
  }
  try {
    await ports.replaceDaemon()
    console.error('[orcad] a client returned during idle stop; started a fresh terminal daemon')
    return 'serving'
  } catch (error) {
    console.error('[orcad] could not replace the retired terminal daemon:', error)
    return 'unservable'
  }
}
