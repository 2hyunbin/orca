import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsWatch = vi.hoisted(() => {
  const state: { listener: (() => void) | null } = { listener: null }
  return state
})
vi.mock('node:fs', () => ({
  watch: (_root: string, _options: unknown, listener: () => void) => {
    fsWatch.listener = listener
    return Object.assign(new EventEmitter(), { close: vi.fn() })
  }
}))

import { watchWindowsRuntimeFileExplorer } from './windows-file-watch'

describe('watchWindowsRuntimeFileExplorer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps emitting overflow refreshes while raw events never stop', () => {
    const callback = vi.fn()
    watchWindowsRuntimeFileExplorer('C:\\repo', callback, vi.fn())
    // Raw events every 50 ms: a resetting debounce would never fire.
    for (let elapsed = 0; elapsed < 1_000; elapsed += 50) {
      fsWatch.listener?.()
      vi.advanceTimersByTime(50)
    }
    expect(callback.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(callback).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])
  })
})
