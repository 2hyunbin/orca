import type pg from 'pg'

// A floor above healthy US round trips (1.7-4.5 ms medians); the 10-26 director stalls held one connection at 52-59 ms.
export const SLOW_CONNECTION_MEDIAN_MS = 25
// Relative to the pool's other connections, so a far region's round trip, a slow database, event-loop
// lag or a lock convoy (which slow every connection alike) never retire anything.
export const SLOW_CONNECTION_PEER_RATIO = 3
// Enough statements that one lock wait or slow plan cannot retire a healthy connection.
export const SLOW_CONNECTION_WINDOW = 16
// Fewer samples than this make a peer's median noise, so it does not count as a comparison.
export const SLOW_CONNECTION_PEER_MIN_SAMPLES = 8
// Older samples describe a connection that may have recovered since.
export const SLOW_CONNECTION_SAMPLE_MAX_AGE_MS = 60_000
// Per pool: bounds reconnects if the rule ever misfires.
export const SLOW_CONNECTION_RETIRE_INTERVAL_MS = 10_000

type Sample = { ms: number; at: number }

const recentStatements = new WeakMap<pg.PoolClient, Sample[]>()

export function noteConnectionStatement(client: pg.PoolClient, durationMs: number): void {
  const sample = { ms: durationMs, at: Date.now() }
  const samples = recentStatements.get(client)
  if (!samples) {
    recentStatements.set(client, [sample])
    return
  }
  samples.push(sample)
  if (samples.length > SLOW_CONNECTION_WINDOW) {
    samples.shift()
  }
}

// Lower median: with an even window, one long statement still cannot lift it.
function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[(values.length - 1) >> 1] ?? 0
}

// pg-pool reuses the most recently released client, so a slow connection that stays busy is never
// idle long enough to close; it keeps serving every ask until something destroys it.
export class SlowConnectionRetirement {
  private lastRetiredAt = Number.NEGATIVE_INFINITY
  // Clients this pool has released; entries leave once their samples go stale.
  private readonly clients = new Set<pg.PoolClient>()

  constructor(private readonly now: () => number = Date.now) {}

  forget(client: pg.PoolClient): void {
    this.clients.delete(client)
    recentStatements.delete(client)
  }

  // True when the caller should destroy the client instead of returning it to the pool.
  shouldRetire(client: pg.PoolClient, connectionId: number): boolean {
    this.clients.add(client)
    const now = this.now()
    const since = (candidate: pg.PoolClient, from: number): Sample[] =>
      (recentStatements.get(candidate) ?? []).filter((sample) => sample.at >= from)
    const own = since(client, now - SLOW_CONNECTION_SAMPLE_MAX_AGE_MS)
    if (own.length < SLOW_CONNECTION_WINDOW) {
      return false
    }
    // Peers are judged over the same span, so a slowdown reaching every connection reads as one.
    const span = own[0]?.at ?? now
    const peerMedians: number[] = []
    for (const peer of this.clients) {
      if (peer === client) {
        continue
      }
      if (since(peer, now - SLOW_CONNECTION_SAMPLE_MAX_AGE_MS).length === 0) {
        this.clients.delete(peer)
        continue
      }
      const samples = since(peer, span)
      if (samples.length >= SLOW_CONNECTION_PEER_MIN_SAMPLES) {
        peerMedians.push(median(samples.map((sample) => sample.ms)))
      }
    }
    if (peerMedians.length === 0) {
      return false
    }
    const medianMs = median(own.map((sample) => sample.ms))
    const peerMedianMs = median(peerMedians)
    if (medianMs <= SLOW_CONNECTION_MEDIAN_MS || medianMs < peerMedianMs * SLOW_CONNECTION_PEER_RATIO) {
      return false
    }
    if (now - this.lastRetiredAt < SLOW_CONNECTION_RETIRE_INTERVAL_MS) {
      return false
    }
    this.lastRetiredAt = now
    this.forget(client)
    // Cloud Run labels each line with its instance, so retirements count per instance.
    console.warn(
      JSON.stringify({
        event: 'orca_relay_postgres_slow_connection_retired',
        connectionId,
        medianMs: Math.round(medianMs * 1_000) / 1_000,
        peerMedianMs: Math.round(peerMedianMs * 1_000) / 1_000,
        statements: own.length
      })
    )
    return true
  }
}
