/**
 * The bridge's two waits: retrying relays it couldn't ask, and attaches waiting on a relay to answer.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 30_000

/** Doubling backoff, one pending retry at a time. */
export class LegacyRelayRetry {
  private handle: ReturnType<typeof setTimeout> | null = null
  private delayMs = RETRY_MIN_MS

  constructor(private readonly run: () => void) {}

  schedule(): void {
    if (this.handle !== null) {
      return
    }
    const delay = this.delayMs
    this.delayMs = Math.min(this.delayMs * 2, RETRY_MAX_MS)
    this.handle = setTimeout(() => {
      this.handle = null
      this.run()
    }, delay)
  }

  reset(): void {
    this.delayMs = RETRY_MIN_MS
  }

  cancel(): void {
    if (this.handle !== null) {
      clearTimeout(this.handle)
      this.handle = null
    }
  }
}

/** Callers parked until a condition holds or a deadline passes; `wake` re-checks every one. */
export class LegacyRelayWaiters {
  private readonly waiters = new Set<() => void>()

  waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve()
      }
      const check = (): void => {
        if (done()) {
          finish()
        }
      }
      const timer = setTimeout(finish, timeoutMs)
      this.waiters.add(check)
      check()
    })
  }

  wake(): void {
    for (const waiter of Array.from(this.waiters)) {
      waiter()
    }
  }
}

/** Stops awaiting the relay's exit proof (its report, or a complete listing without the pane). */
export class LegacyRelayExitProofs {
  private readonly awaiting = new Map<string, boolean>()
  private readonly waiters = new LegacyRelayWaiters()
  private disposed = false

  async wait(ptyId: string, timeoutMs: number): Promise<boolean> {
    this.awaiting.set(ptyId, false)
    await this.waiters.waitUntil(
      () => this.disposed || this.awaiting.get(ptyId) === true,
      timeoutMs
    )
    const exited = this.awaiting.get(ptyId) === true
    this.awaiting.delete(ptyId)
    return exited && !this.disposed
  }

  observe(ptyId: string): void {
    if (this.awaiting.has(ptyId)) {
      this.awaiting.set(ptyId, true)
      this.waiters.wake()
    }
  }

  dispose(): void {
    this.disposed = true
    this.waiters.wake()
  }
}
