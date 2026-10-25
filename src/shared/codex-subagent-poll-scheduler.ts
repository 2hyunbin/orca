/** Share one deadline timer while keeping each pane’s deadline/payload/cancellation independent. */
// Use elapsed monotonic time so wall-clock corrections cannot stretch poll deadlines.
const monotonicNow = (): number => performance.now()

export class CodexSubagentPollScheduler<T> {
  private readonly entries = new Map<string, { value: T; dueAt: number }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDueAt: number | undefined
  private timerGeneration = 0
  private flushing = false

  constructor(
    private readonly delayMs: number,
    private readonly onDue: (key: string, value: T) => void,
    private readonly now: () => number = monotonicNow
  ) {}

  schedule(key: string, value: T, delayMs = this.delayMs): void {
    this.entries.delete(key)
    this.entries.set(key, { value, dueAt: this.now() + delayMs })
    this.arm()
  }

  clear(key: string): void {
    if (!this.entries.delete(key)) {
      return
    }
    this.arm()
  }

  clearAll(): void {
    this.entries.clear()
    this.cancelTimer()
  }

  get size(): number {
    return this.entries.size
  }

  private arm(): void {
    if (this.flushing) {
      return
    }
    if (this.entries.size === 0) {
      this.cancelTimer()
      return
    }

    let nextDueAt = Number.POSITIVE_INFINITY
    for (const entry of this.entries.values()) {
      nextDueAt = Math.min(nextDueAt, entry.dueAt)
    }
    if (this.timer !== undefined && this.timerDueAt === nextDueAt) {
      return
    }
    if (this.timer !== undefined) {
      this.cancelTimer()
    }
    const generation = ++this.timerGeneration
    this.timerDueAt = nextDueAt
    const timer = setTimeout(
      () => {
        // Queued callbacks from replaced timers must not consume the active timer’s metadata or entries.
        if (this.timerGeneration !== generation || this.timer !== timer) {
          return
        }
        this.timer = undefined
        this.timerDueAt = undefined
        this.flush()
      },
      Math.max(0, nextDueAt - this.now())
    )
    this.timer = timer
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private cancelTimer(): void {
    const timer = this.timer
    this.timer = undefined
    this.timerDueAt = undefined
    this.timerGeneration += 1
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }

  private flush(): void {
    const now = this.now()
    this.flushing = true
    try {
      // Live iteration observes sibling cancellation and delete/reinsert ordering.
      for (const [key, entry] of this.entries) {
        if (entry.dueAt > now) {
          continue
        }
        this.entries.delete(key)
        this.onDue(key, entry.value)
      }
    } finally {
      this.flushing = false
      this.arm()
    }
  }
}
