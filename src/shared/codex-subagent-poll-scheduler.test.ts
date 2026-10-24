import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexSubagentPollScheduler } from './codex-subagent-poll-scheduler'

describe('CodexSubagentPollScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('arms one timer and preserves registration order for simultaneous panes', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const scheduler = new CodexSubagentPollScheduler(1_000, (key) => {
      seen.push(key)
    })

    scheduler.schedule('pane-a', undefined)
    scheduler.schedule('pane-b', undefined)
    scheduler.schedule('pane-c', undefined)

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(999)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)

    expect(seen).toEqual(['pane-a', 'pane-b', 'pane-c'])
    expect(scheduler.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps staggered deadlines and cancellation independent', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const scheduler = new CodexSubagentPollScheduler(1_000, (key) => {
      seen.push(key)
    })

    scheduler.schedule('pane-a', undefined)
    vi.advanceTimersByTime(500)
    scheduler.schedule('pane-b', undefined)
    scheduler.clear('pane-a')

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(999)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['pane-b'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a pending poll on schedule when the wall clock rolls back', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'))
    const seen: string[] = []
    const scheduler = new CodexSubagentPollScheduler(1_000, (key) => {
      seen.push(key)
    })

    scheduler.schedule('pane-a', undefined)
    vi.advanceTimersByTime(500)
    vi.setSystemTime(new Date('2025-08-30T12:00:00.000Z'))
    vi.advanceTimersByTime(500)

    expect(seen).toEqual(['pane-a'])
    expect(scheduler.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a stale callback after replacing a timer', () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const seen: string[] = []
    const scheduler = new CodexSubagentPollScheduler<string>(1_000, (key, value) => {
      seen.push(`${key}:${value}`)
    })

    scheduler.schedule('pane-a', 'first')
    const staleCallback = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    expect(staleCallback).toBeDefined()

    vi.advanceTimersByTime(500)
    scheduler.schedule('pane-a', 'replacement')
    expect(vi.getTimerCount()).toBe(1)

    staleCallback?.()
    expect(vi.getTimerCount()).toBe(1)
    expect(seen).toEqual([])

    vi.advanceTimersByTime(500)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(500)
    expect(seen).toEqual(['pane-a:replacement'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a stale callback after clearing all entries', () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const seen: string[] = []
    const scheduler = new CodexSubagentPollScheduler(1_000, (key) => {
      seen.push(key)
    })

    scheduler.schedule('pane-a', undefined)
    const staleCallback = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    scheduler.clearAll()

    staleCallback?.()
    expect(seen).toEqual([])
    expect(scheduler.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('drains live mutations and rearms after callback failure=%s', (fail) => {
    vi.useFakeTimers()
    const seen: string[] = []
    const scheduler = new CodexSubagentPollScheduler<string>(10, (key, value) => {
      seen.push(value)
      if (key !== 'a') {
        return
      }
      scheduler.clear('b')
      scheduler.schedule('c', 'replaced', 0)
      scheduler.schedule('new', 'new', 0)
      if (fail) {
        scheduler.clearAll()
        scheduler.schedule('live', 'readmitted', 0)
        throw new Error('callback failure')
      }
    })
    scheduler.schedule('future', 'future', 100)
    for (const key of ['a', 'b', 'c']) {
      scheduler.schedule(key, key)
    }
    const flush = () => vi.advanceTimersByTime(10)
    if (fail) {
      expect(flush).toThrow('callback failure')
    } else {
      flush()
    }
    expect(seen).toEqual(fail ? ['a'] : ['a', 'replaced', 'new'])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(100)
    expect(seen).toEqual(fail ? ['a', 'readmitted'] : ['a', 'replaced', 'new', 'future'])
    expect([scheduler.size, vi.getTimerCount()]).toEqual([0, 0])
  })

  it('lets a due callback cancel a sibling before that sibling runs', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    let scheduler!: CodexSubagentPollScheduler<undefined>
    scheduler = new CodexSubagentPollScheduler(1_000, (key) => {
      seen.push(key)
      if (key === 'pane-a') {
        scheduler.clear('pane-b')
      }
    })

    scheduler.schedule('pane-a', undefined)
    scheduler.schedule('pane-b', undefined)
    vi.advanceTimersByTime(1_000)

    expect(seen).toEqual(['pane-a'])
    expect(scheduler.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
