import type pg from 'pg'

// Healthy connections run at a 1.7-4.5 ms median; the 10-26 director stalls held one connection at 52-59 ms.
export const SLOW_CONNECTION_MEDIAN_MS = 25
// Enough statements that one lock wait or slow plan cannot retire a healthy connection.
export const SLOW_CONNECTION_WINDOW = 16
// Bounds reconnects when the whole database is slow and every connection crosses the threshold.
export const SLOW_CONNECTION_RETIRE_INTERVAL_MS = 10_000

const recentStatementMs = new WeakMap<pg.PoolClient, number[]>()

export function noteConnectionStatement(client: pg.PoolClient, durationMs: number): void {
  const samples = recentStatementMs.get(client)
  if (!samples) {
    recentStatementMs.set(client, [durationMs])
    return
  }
  samples.push(durationMs)
  if (samples.length > SLOW_CONNECTION_WINDOW) {
    samples.shift()
  }
}

// Lower median: with an even window, one long statement still cannot lift it.
function median(samples: number[]): number {
  return [...samples].sort((a, b) => a - b)[(samples.length - 1) >> 1] ?? 0
}

// pg-pool reuses the most recently released client, so a slow connection that stays busy is never
// idle long enough to close; it keeps serving every ask until something destroys it.
export class SlowConnectionRetirement {
  private lastRetiredAt = Number.NEGATIVE_INFINITY

  constructor(private readonly now: () => number = Date.now) {}

  // True when the caller should destroy the client instead of returning it to the pool.
  shouldRetire(client: pg.PoolClient, connectionId: number): boolean {
    const samples = recentStatementMs.get(client)
    if (!samples || samples.length < SLOW_CONNECTION_WINDOW) {
      return false
    }
    const medianMs = median(samples)
    if (medianMs <= SLOW_CONNECTION_MEDIAN_MS) {
      return false
    }
    const now = this.now()
    if (now - this.lastRetiredAt < SLOW_CONNECTION_RETIRE_INTERVAL_MS) {
      return false
    }
    this.lastRetiredAt = now
    recentStatementMs.delete(client)
    // Cloud Run labels each line with its instance, so retirements count per instance.
    console.warn(
      JSON.stringify({
        event: 'orca_relay_postgres_slow_connection_retired',
        connectionId,
        medianMs: Math.round(medianMs * 1_000) / 1_000,
        statements: samples.length
      })
    )
    return true
  }
}
