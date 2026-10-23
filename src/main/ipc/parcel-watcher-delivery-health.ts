import type { WatcherProcessCrashFuse } from './parcel-watcher-crash-fuse'
import { CANARY_STALL_BACKOFF_INITIAL_MS } from './parcel-watcher-delivery-canary'
import type { WatcherProcessSubscriptionRecord } from './parcel-watcher-process-subscription'

/**
 * Host side of the child's canary health reports. Why: during an OS event
 * stall the child keeps its streams, so subscriptions would go silently stale.
 * Once a stall outlasts one canary backoff period, every caller gets an
 * overflow (rescan) on that cadence, and one more when delivery recovers.
 */
export class WatcherDeliveryHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly records: Map<number, WatcherProcessSubscriptionRecord>,
    private readonly crashFuse: WatcherProcessCrashFuse,
    private readonly rescanIntervalMs = CANARY_STALL_BACKOFF_INITIAL_MS
  ) {}

  childStarted(): void {
    this.reset()
    this.crashFuse.noteChildStarted()
  }

  update(state: 'healthy' | 'stalled'): void {
    this.crashFuse.recordDeliveryHealth(state)
    if (state === 'stalled') {
      if (this.timer === null) {
        this.timer = setInterval(() => this.rescanAll(), this.rescanIntervalMs)
        this.timer.unref?.()
      }
      return
    }
    if (this.timer !== null) {
      this.reset()
      this.rescanAll()
    }
  }

  /** The child is gone; crash recovery resyncs records through onInterruption. */
  reset(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private rescanAll(): void {
    for (const record of Array.from(this.records.values())) {
      if (!record.pendingSubscribe && !record.interrupted) {
        record.hooks.onOverflow?.()
      }
    }
  }
}
