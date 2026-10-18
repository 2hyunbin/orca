// Why: the main-process watcher batcher and the runtime files.watch batcher
// share one flush window so local and remote latency can't drift.

// Why: a trailing debounce never fires while agents write continuously, so a
// busy worktree waited for the max-wait cap on every batch. Instead the first
// change after a quiet period flushes after a short coalescing tick, and a
// sustained stream flushes on a fixed cadence.
export const WATCH_BATCH_LEADING_MS = 25
export const WATCH_BATCH_INTERVAL_MS = 100

/** Delay before flushing a batch armed at `now`; `lastFlushAt` is 0 before the first flush. */
export function watchBatchFlushDelayMs(
  now: number,
  lastFlushAt: number,
  leadingMs: number = WATCH_BATCH_LEADING_MS,
  intervalMs: number = WATCH_BATCH_INTERVAL_MS
): number {
  return Math.max(leadingMs, lastFlushAt + intervalMs - now)
}
