// Half-open tunnels never emit close, preventing reconnect (#7718/#7489). Ping periodically and require any inbound activity
// so existing close/reconnect paths run. RFC 6455 control pings work with older embedded ws servers too.

export const REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS = 10_000
// Detect loss just under two server heartbeat periods (15s), aligning with the host reaper.
export const REMOTE_RUNTIME_SOCKET_LIVENESS_TIMEOUT_MS = 25_000

export type RemoteRuntimeSocketLivenessOptions = {
  pingIntervalMs?: number
  livenessTimeoutMs?: number
}

// Sleep/network changes can leave OPEN sockets on dead paths; explicit resume probes avoid the normal ~30–40s detection delay.
export const REMOTE_RUNTIME_SOCKET_RESUME_PROBE_DEADLINE_MS = 8_000

export type RemoteRuntimeSocketLivenessMonitor = {
  noteActivity: () => void
  /** Ping now; declare the socket dead unless anything arrives within `deadlineMs`. */
  probeNow: (deadlineMs?: number) => void
  stop: () => void
}

const activeMonitors = new Set<RemoteRuntimeSocketLivenessMonitor>()

/** Probe every live remote-runtime socket in this process, e.g. on OS resume or network change. */
export function probeAllRemoteRuntimeSocketsNow(
  deadlineMs = REMOTE_RUNTIME_SOCKET_RESUME_PROBE_DEADLINE_MS
): number {
  const monitors = Array.from(activeMonitors)
  for (const monitor of monitors) {
    monitor.probeNow(deadlineMs)
  }
  return monitors.length
}

export function startRemoteRuntimeSocketLiveness(args: {
  /** Returns false when nothing was sent, e.g. the socket is still connecting. */
  ping: () => boolean
  onDead: () => void
  options?: RemoteRuntimeSocketLivenessOptions
  now?: () => number
}): RemoteRuntimeSocketLivenessMonitor {
  const now = args.now ?? Date.now
  const pingIntervalMs = args.options?.pingIntervalMs ?? REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS
  const livenessTimeoutMs =
    args.options?.livenessTimeoutMs ?? REMOTE_RUNTIME_SOCKET_LIVENESS_TIMEOUT_MS
  let lastTickAt = now()
  let probeSentAt: number | null = null
  let activitySinceResumeProbe = false
  let resumeProbeTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const timer = setInterval(() => {
    if (stopped) {
      return
    }
    const tickAt = now()
    const tickElapsedMs = tickAt - lastTickAt
    lastTickAt = tickAt
    // Why: sleep and background throttling age sockets without giving them a chance to answer.
    if (tickElapsedMs < 0 || tickElapsedMs > pingIntervalMs * 1.5) {
      probeSentAt = tickAt
      tryPing()
      return
    }
    if (probeSentAt !== null && tickAt - probeSentAt > livenessTimeoutMs) {
      stop()
      args.onDead()
      return
    }
    if (probeSentAt === null) {
      probeSentAt = tickAt
      tryPing()
    }
  }, pingIntervalMs)
  // Why: mobile typechecks shared code with DOM timer types where unref is absent.
  const unrefable = timer as unknown as { unref?: () => void }
  if (typeof unrefable.unref === 'function') {
    unrefable.unref()
  }

  function stop(): void {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(timer)
    if (resumeProbeTimer !== null) {
      clearTimeout(resumeProbeTimer)
      resumeProbeTimer = null
    }
    activeMonitors.delete(monitor)
  }

  function probeNow(deadlineMs = REMOTE_RUNTIME_SOCKET_RESUME_PROBE_DEADLINE_MS): void {
    if (stopped || resumeProbeTimer !== null) {
      return
    }
    activitySinceResumeProbe = false
    // Why: a socket still connecting has no path to probe yet; a deadline with no ping could kill it mid-handshake.
    if (!tryPing()) {
      return
    }
    const probedAt = now()
    resumeProbeTimer = setTimeout(() => {
      resumeProbeTimer = null
      if (stopped || activitySinceResumeProbe) {
        return
      }
      // Why: a late timer means this process slept or stalled, so replies may still be queued; probe afresh.
      const elapsedMs = now() - probedAt
      if (elapsedMs < 0 || elapsedMs > deadlineMs * 1.5) {
        probeNow(deadlineMs)
        return
      }
      stop()
      args.onDead()
    }, deadlineMs)
    // Why: mobile typechecks shared code with DOM timer types where unref is absent.
    const timer: unknown = resumeProbeTimer
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref()
    }
  }

  function tryPing(): boolean {
    try {
      return args.ping()
    } catch {
      // Why: ping() can throw while a socket is mid-teardown; the probe deadline still settles it.
      return true
    }
  }

  const monitor: RemoteRuntimeSocketLivenessMonitor = {
    noteActivity: () => {
      probeSentAt = null
      activitySinceResumeProbe = true
    },
    probeNow,
    stop
  }
  activeMonitors.add(monitor)
  return monitor
}
