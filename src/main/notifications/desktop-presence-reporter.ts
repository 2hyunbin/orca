import {
  DESKTOP_PRESENCE_REPORT_INTERVAL_MS,
  NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY
} from '../../shared/desktop-client-presence'
import { getRuntimeEnvironmentStatusSnapshots } from '../ipc/runtime-environments/runtime-environment-request-connections'
import {
  listReadySharedControlSockets,
  type ReadySharedControlSocket
} from '../ipc/runtime-environments/runtime-environment-shared-control-answers'

/** How often local idle state is sampled, so a return to the desk reaches hosts within seconds. */
const SAMPLE_INTERVAL_MS = 5_000
const REPORT_TIMEOUT_MS = 10_000

type Sent = { socket: number; away: boolean; at: number }

export type DesktopPresenceReporterDeps = {
  readAway: () => boolean | undefined
  listTargets: (capability: string) => ReadySharedControlSocket[]
  now?: () => number
}

/**
 * Tells each connected host whether someone is at this desktop, so a headless host can honor a
 * phone's "only when desktop is away" (#31570). Sent on change, on a new socket, and as a keepalive.
 */
export function createDesktopPresenceReporter(
  deps: DesktopPresenceReporterDeps
): (forceAway?: boolean) => void {
  const now = deps.now ?? Date.now
  const sent = new Map<string, Sent>()
  return (forceAway = false) => {
    const targets = deps.listTargets(NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY)
    if (targets.length === 0) {
      sent.clear()
      return
    }
    // Why: unknown local presence must never silence a phone, so only a proven "active" is present.
    const away = forceAway || deps.readAway() !== false
    const at = now()
    const live = new Set(targets.map((target) => target.environmentId))
    for (const environmentId of sent.keys()) {
      if (!live.has(environmentId)) {
        sent.delete(environmentId)
      }
    }
    for (const target of targets) {
      const last = sent.get(target.environmentId)
      if (
        last &&
        last.socket === target.socket &&
        last.away === away &&
        at - last.at < DESKTOP_PRESENCE_REPORT_INTERVAL_MS
      ) {
        continue
      }
      const entry = { socket: target.socket, away, at }
      sent.set(target.environmentId, entry)
      // Why: a refused report waits for the keepalive; only an unsent one retries on the next tick.
      void target
        .request('notifications.reportDesktopPresence', { away }, REPORT_TIMEOUT_MS)
        .catch(() => {
          if (sent.get(target.environmentId) === entry) {
            sent.delete(target.environmentId)
          }
        })
    }
  }
}

/** Ready control sockets whose host's last status advertised `capability`. */
export function listCapableSharedControlSockets(capability: string): ReadySharedControlSocket[] {
  const capable = new Set(
    getRuntimeEnvironmentStatusSnapshots()
      .filter((snapshot) => snapshot.status?.capabilities?.includes(capability))
      .map((snapshot) => snapshot.environmentId)
  )
  return listReadySharedControlSockets().filter((target) => capable.has(target.environmentId))
}

export function startDesktopPresenceReporter(
  deps: DesktopPresenceReporterDeps & {
    /** Sleep and screen lock: report away at once instead of leaving hosts to the TTL. */
    subscribeAwayEvents: (onAway: () => void) => () => void
  }
): () => void {
  const tick = createDesktopPresenceReporter(deps)
  const timer = setInterval(tick, SAMPLE_INTERVAL_MS)
  // Why: presence reporting must never hold the app open at quit.
  timer.unref?.()
  const unsubscribe = deps.subscribeAwayEvents(() => tick(true))
  return () => {
    clearInterval(timer)
    unsubscribe()
  }
}
