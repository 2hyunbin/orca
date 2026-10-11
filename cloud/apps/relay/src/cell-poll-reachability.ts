// Whether this director's own seat-feed polls reach a cell: one half of the evidence that lets a
// host that lost its control leave a dead reserve cell without an operator fence. The other half
// is the cell's stale heartbeat, which travels a different path (cell -> director -> Postgres).

// The failing streak must span this long: the heartbeat TTL, so neither signal outruns the other.
export const CELL_POLL_DEAD_STREAK_MS = 45_000
export const CELL_POLL_DEAD_MIN_FAILURES = 3
// A gap this long (a frozen director, a stopped poller) restarts the streak: unasked is not unanswered.
export const CELL_POLL_DEAD_MAX_GAP_MS = 5_000

type Streak = { startedAt: number; failures: number; lastFailedAt: number }

// Statuses that come from the load balancer, never from the cell: no backend took the request.
const NO_BACKEND_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

export function isNoBackendStatus(status: number): boolean {
  return NO_BACKEND_STATUSES.has(status)
}

export class CellPollReachability {
  private readonly streaks = new Map<string, Streak>()

  // Any answer from the cell, a 401 or 404 included, proves it alive.
  answered(cellId: string): void {
    this.streaks.delete(cellId)
  }

  // A timeout, a connection failure, or a load balancer that found no backend.
  unanswered(cellId: string, now: number): void {
    const streak = this.streaks.get(cellId)
    if (!streak || now - streak.lastFailedAt > CELL_POLL_DEAD_MAX_GAP_MS) {
      this.streaks.set(cellId, { startedAt: now, failures: 1, lastFailedAt: now })
      return
    }
    streak.failures += 1
    streak.lastFailedAt = now
  }

  forget(cellIds: ReadonlySet<string>): void {
    for (const cellId of this.streaks.keys()) if (!cellIds.has(cellId)) this.streaks.delete(cellId)
  }

  private unreachable(cellId: string, now: number): boolean {
    const streak = this.streaks.get(cellId)
    return (
      streak !== undefined &&
      streak.failures >= CELL_POLL_DEAD_MIN_FAILURES &&
      now - streak.lastFailedAt <= CELL_POLL_DEAD_MAX_GAP_MS &&
      streak.lastFailedAt - streak.startedAt >= CELL_POLL_DEAD_STREAK_MS
    )
  }

  // Unreachable, unless more than a third of the polled cells are at once: that is this director's
  // network or credential failing, not the cells.
  dead(cellId: string, polledCells: number, now: number): boolean {
    if (!this.unreachable(cellId, now)) return false
    let unreachable = 0
    for (const other of this.streaks.keys()) if (this.unreachable(other, now)) unreachable += 1
    return unreachable * 3 <= polledCells
  }
}
