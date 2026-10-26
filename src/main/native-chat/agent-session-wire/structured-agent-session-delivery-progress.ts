// Delivery re-derives only after a step proves what it changed; re-deriving unchanged state repeats it forever.

import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'

type Reads = Pick<StructuredAgentSessionDeliveryLoopDeps, 'sessions' | 'startFlights'>
type Sample = { journal: string; child: string; startFlight: boolean; wakes: number }

/** What moved delivery on: a commit, a different or re-phased child, a joined start that ended, or a wake. */
export type StructuredAgentSessionDeliveryTransition = 'journal' | 'child' | 'startup' | 'wake'

/** The transition a step observed; null when re-deriving would repeat the same step. */
function deliveryTransition(
  before: Sample,
  now: Sample
): StructuredAgentSessionDeliveryTransition | null {
  if (before.journal !== now.journal) {
    return 'journal'
  }
  if (before.child !== now.child) {
    return 'child'
  }
  if (before.startFlight && !now.startFlight) {
    return 'startup'
  }
  return before.wakes === now.wakes ? null : 'wake'
}

export class StructuredAgentSessionDeliveryProgress {
  private readonly wakes = new Map<string, number>()
  private readonly steps = new Map<string, Sample>()

  woke(sessionId: string): void {
    this.wakes.set(sessionId, (this.wakes.get(sessionId) ?? 0) + 1)
  }

  /** A new run owes its first step nothing. */
  begin(sessionId: string): void {
    this.steps.delete(sessionId)
  }

  /** Under serialization at each step's start: false when nothing changed since the previous step began. */
  advanced(sessionId: string, reads: Reads): boolean {
    const before = this.steps.get(sessionId)
    const now = this.sample(sessionId, reads)
    this.steps.set(sessionId, now)
    return before === undefined || deliveryTransition(before, now) !== null
  }

  private sample(sessionId: string, reads: Reads): Sample {
    const session = reads.sessions.get(sessionId)
    const cursor = session?.journal.cursor()
    const child = session?.child
    return {
      journal: `${cursor?.epoch}:${cursor?.sequence}`,
      child: JSON.stringify([
        child?.generation,
        child?.fence,
        child?.phase,
        child?.close !== undefined
      ]),
      startFlight: reads.startFlights?.has(sessionId) === true,
      wakes: this.wakes.get(sessionId) ?? 0
    }
  }
}
