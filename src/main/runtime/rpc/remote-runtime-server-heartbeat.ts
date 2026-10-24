import type { WebSocket } from 'ws'

// Cellular/Tailscale loss may swallow one pong (STA-3320); require consecutive misses. Three matches web-client tolerance after initial grace.
const MISSED_PROBE_LIMIT = 3

export class RemoteRuntimeServerHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTickAt: number | null = null
  private readonly alive = new WeakSet<WebSocket>()
  // Absent miss count means zero without retaining state for live sockets.
  private readonly missedProbes = new WeakMap<WebSocket, number>()

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly warningClientCount = 128,
    private readonly missedProbeLimit = MISSED_PROBE_LIMIT
  ) {}

  // Inbound hot path only marks life; the sweep resets misses.
  noteAlive(socket: WebSocket): void {
    this.alive.add(socket)
  }

  start(getClients: () => Iterable<WebSocket>): void {
    if (this.timer) {
      return
    }
    this.lastTickAt = this.now()
    this.timer = setInterval(() => this.sweep(getClients()), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.lastTickAt = null
  }

  private sweep(clients: Iterable<WebSocket>): void {
    const tickAt = this.now()
    const elapsedMs = tickAt - (this.lastTickAt ?? tickAt)
    this.lastTickAt = tickAt
    // A delayed tick cannot charge a probe clients could not answer, but clearing banked misses would shelter dead sockets forever.
    // Preserve the count; responsive clients clear it by answering the next probe.
    const stalledTick = elapsedMs < 0 || elapsedMs > this.intervalMs * 1.5
    let reaped = 0
    let clientCount = 0
    for (const socket of clients) {
      clientCount += 1
      if (this.alive.has(socket)) {
        this.alive.delete(socket)
        this.missedProbes.delete(socket)
      } else if (!stalledTick) {
        const missed = (this.missedProbes.get(socket) ?? 0) + 1
        if (missed >= this.missedProbeLimit) {
          this.missedProbes.delete(socket)
          socket.terminate()
          reaped += 1
          continue
        }
        this.missedProbes.set(socket, missed)
      }
      try {
        // Re-probe even after misses so recovered paths can immediately prove life.
        socket.ping()
      } catch {
        // Close/error listeners finalize sockets already tearing down.
      }
    }
    if (reaped > 0 || clientCount >= this.warningClientCount) {
      console.warn(`[ws-transport] heartbeat reaped ${reaped}; ${clientCount} tracked sockets`)
    }
  }
}
