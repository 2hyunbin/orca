// Concurrent host waits keep their own cancellation handles until they settle.

export class StructuredAgentSessionAcquireAborts {
  private readonly inFlight = new Map<
    string,
    Set<{ controller: AbortController; handover: boolean }>
  >()
  /** Set by quit: the host is going away, so an attach that begins after it starts aborted. */
  private quitReason: Error | null = null

  /** For the provider wait about to run; `end` once it settles. */
  begin(sessionId: string, handover = false): { signal: AbortSignal; end: () => void } {
    const controller = new AbortController()
    if (this.quitReason) {
      controller.abort(this.quitReason)
    }
    const waits =
      this.inFlight.get(sessionId) ?? new Set<{ controller: AbortController; handover: boolean }>()
    const active = { controller, handover }
    waits.add(active)
    this.inFlight.set(sessionId, waits)
    return {
      signal: controller.signal,
      end: () => {
        waits.delete(active)
        if (waits.size === 0 && this.inFlight.get(sessionId) === waits) {
          this.inFlight.delete(sessionId)
        }
      }
    }
  }

  /** A no-op when the session has nothing in flight. */
  abort(sessionId: string, reason: string | Error): boolean {
    let stoppedHandover = false
    for (const { controller, handover } of this.inFlight.get(sessionId) ?? []) {
      stoppedHandover ||= handover && !controller.signal.aborted
      controller.abort(typeof reason === 'string' ? new Error(reason) : reason)
    }
    return stoppedHandover
  }

  /** Quit: every provider wait under way stops, including those queued in the attach drain. */
  abortAll(reason: string): void {
    this.quitReason ??= new Error(reason)
    for (const waits of this.inFlight.values()) {
      for (const { controller } of waits) {
        controller.abort(this.quitReason)
      }
    }
  }
}
