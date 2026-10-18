import { describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import {
  WATCH_BATCH_INTERVAL_MS,
  WATCH_BATCH_LEADING_MS
} from '../../../../shared/filesystem-watch-batch-window'
import { createFileWatchEventBatcher } from './file-watch-event-batcher'

describe('createFileWatchEventBatcher', () => {
  it('keeps precise watcher events while the batch is under the overflow limit', () => {
    const emit = vi.fn()
    const batcher = createFileWatchEventBatcher('worktree-1', emit)
    const events: FsChangeEvent[] = [
      { kind: 'update', absolutePath: '/repo/file-a.ts' },
      { kind: 'delete', absolutePath: '/repo/file-b.ts' }
    ]

    batcher.push(events)
    batcher.flush()

    expect(emit).toHaveBeenCalledWith({
      type: 'changed',
      worktree: 'worktree-1',
      events
    })
  })

  it('collapses very large watcher bursts without spreading them onto the stack', () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const batcher = createFileWatchEventBatcher('worktree-1', emit)
      const event: FsChangeEvent = { kind: 'update', absolutePath: '/repo/file.ts' }
      const burst = Array.from({ length: 200_000 }, () => event)

      expect(() => batcher.push(burst)).not.toThrow()
      batcher.flush()

      expect(emit).toHaveBeenCalledWith({
        type: 'changed',
        worktree: 'worktree-1',
        events: [{ kind: 'overflow', absolutePath: '/repo/file.ts' }]
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes at the leading delay and keeps a sustained stream on the interval', () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const batcher = createFileWatchEventBatcher('worktree-1', emit)
      const event: FsChangeEvent = { kind: 'update', absolutePath: '/repo/file.ts' }

      batcher.push([event])
      vi.advanceTimersByTime(WATCH_BATCH_LEADING_MS - 1)
      batcher.push([event])
      expect(emit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(emit).toHaveBeenCalledTimes(1)

      for (let elapsed = 0; elapsed < 1_000; elapsed += 10) {
        batcher.push([event])
        vi.advanceTimersByTime(10)
      }
      expect(emit.mock.calls.length).toBeGreaterThanOrEqual(1_000 / WATCH_BATCH_INTERVAL_MS)
    } finally {
      vi.useRealTimers()
    }
  })
})
