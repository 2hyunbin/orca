// The acquire each session has in flight, owned by the host that runs it, or another provider wait
// its queue is on (an option write). The queue runs one step at a time, so a session has at most
// one; a close, a Stop admitted now, quit, or the startup limit aborts it from outside the queue
// instead of waiting behind a provider that may never answer.

export class StructuredAgentSessionAcquireAborts {
  private readonly inFlight = new Map<string, { controller: AbortController; handover: boolean }>()
  /** Set by quit: the host is going away, so an attach that begins after it starts aborted. */
  private quitReason: Error | null = null

  /** For the attach about to run; `end` once it settles. */
  begin(sessionId: string, handover = false): { signal: AbortSignal; end: () => void } {
    const controller = new AbortController()
    if (this.quitReason) {
      controller.abort(this.quitReason)
    }
    this.inFlight.set(sessionId, { controller, handover })
    return {
      signal: controller.signal,
      end: () => {
        if (this.inFlight.get(sessionId)?.controller === controller) {
          this.inFlight.delete(sessionId)
        }
      }
    }
  }

  /** A no-op when the session has nothing in flight. */
  abort(sessionId: string, reason: string | Error): boolean {
    const active = this.inFlight.get(sessionId)
    const stoppedHandover = active?.handover === true && !active.controller.signal.aborted
    active?.controller.abort(typeof reason === 'string' ? new Error(reason) : reason)
    return stoppedHandover
  }

  /** Quit: every start under way stops, and so does any the attach drain still runs. */
  abortAll(reason: string): void {
    this.quitReason ??= new Error(reason)
    for (const { controller } of this.inFlight.values()) {
      controller.abort(this.quitReason)
    }
  }
}
