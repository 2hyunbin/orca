import { watchBatchFlushDelayMs } from '../../../../shared/filesystem-watch-batch-window'
import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import { MAX_BATCHED_WATCHER_EVENTS } from '../../../ipc/filesystem-watcher-event-batch'

export function createFileWatchEventBatcher(
  worktree: string,
  emit: (result: unknown) => void
): {
  push: (events: FsChangeEvent[]) => void
  flush: () => void
  dispose: () => void
} {
  let events: FsChangeEvent[] = []
  let overflowed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFlushAt = 0

  const clearTimer = (): void => {
    if (!timer) {
      return
    }
    clearTimeout(timer)
    timer = null
  }

  const flush = (): void => {
    clearTimer()
    const nextEvents = events.splice(0)
    overflowed = false
    if (nextEvents.length === 0) {
      return
    }
    lastFlushAt = Date.now()
    emit({ type: 'changed', worktree, events: nextEvents })
  }

  return {
    push(nextEvents: FsChangeEvent[]): void {
      if (nextEvents.length === 0) {
        return
      }
      if (!overflowed) {
        const incomingOverflow = nextEvents.find((event) => event.kind === 'overflow')
        if (incomingOverflow) {
          events = [incomingOverflow]
          overflowed = true
        } else if (events.length + nextEvents.length > MAX_BATCHED_WATCHER_EVENTS) {
          // Why: once precision is too expensive to retain and stream, one
          // overflow asks clients to refresh safely without a huge payload.
          events = [
            {
              kind: 'overflow',
              absolutePath: nextEvents[0]?.absolutePath ?? events[0]?.absolutePath ?? ''
            }
          ]
          overflowed = true
        } else {
          for (const event of nextEvents) {
            events.push(event)
          }
        }
      }
      // Why: never push an armed flush back; resetting on each event starved delivery under continuous writes.
      if (timer) {
        return
      }
      // Why: remote file-watch events cross the runtime WebSocket before the
      // renderer refreshes the tree. Match local watcher batching here.
      timer = setTimeout(flush, watchBatchFlushDelayMs(Date.now(), lastFlushAt))
      if (typeof timer.unref === 'function') {
        timer.unref()
      }
    },
    flush,
    dispose(): void {
      clearTimer()
      events = []
      overflowed = false
    }
  }
}
