import { createHash } from 'node:crypto'
import type { CellFlags } from './cell-flags.js'
import type { AppliedControlFlags } from './relay-control-flag-channel.js'

// Without placing-director contact, memory-only reserve ownership cannot supersede hosts; flip back to db and re-register as a switch flip would.
export const RESERVE_DEAD_MAN_MS = 60_000
const RESERVE_DEAD_MAN_SPREAD_MS = 60_000

// Stable 60–120s per-cell windows stagger fleet-wide fallback DB re-registration over one minute.
export function reserveDeadManWindowMs(cellId: string): number {
  const digest = createHash('sha256').update(cellId).digest()
  return RESERVE_DEAD_MAN_MS + (digest.readUInt32BE(0) % (RESERVE_DEAD_MAN_SPREAD_MS + 1))
}

export class ReserveDeadMan {
  private lastContactAt: number
  private reserveGeneration: number | null = null
  private trippedGeneration: number | null = null

  constructor(
    private readonly cellId: string,
    private readonly now: () => number = Date.now,
    private readonly windowMs = RESERVE_DEAD_MAN_MS,
    private readonly log: (line: string) => void = (line) => console.error(line)
  ) {
    this.lastContactAt = now()
  }

  // A feed poll marked reserver=1, or a real (not dry-run) booking.
  contact(): void {
    this.lastContactAt = this.now()
  }

  // Latch fallback per switch generation; returning directors cannot flap mode until a new reserve write.
  mode(applied: AppliedControlFlags<CellFlags>): 'db' | 'reserve' {
    if (applied.flags.admitMode !== 'reserve') {
      this.reserveGeneration = null
      return 'db'
    }
    const now = this.now()
    if (this.reserveGeneration !== applied.generation) {
      // A new reserve write starts its own window.
      this.reserveGeneration = applied.generation
      this.trippedGeneration = null
      this.lastContactAt = Math.max(this.lastContactAt, now)
    }
    if (this.trippedGeneration === applied.generation) return 'db'
    if (now - this.lastContactAt <= this.windowMs) return 'reserve'
    this.trippedGeneration = applied.generation
    this.log(
      JSON.stringify({
        event: 'orca_relay_cell_reserve_dead_man_tripped',
        cellId: this.cellId,
        generation: applied.generation,
        silentMs: now - this.lastContactAt
      })
    )
    return 'db'
  }
}
