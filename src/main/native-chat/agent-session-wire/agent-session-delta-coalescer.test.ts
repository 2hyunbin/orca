import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_DELTA_COALESCE_MS,
  AGENT_SESSION_STREAMED_TEXT_MAX_GAP_MS,
  createAgentSessionDeltaCoalescer
} from './agent-session-delta-coalescer'

/** Drives the window by hand so the test asserts scheduling, not wall time. */
function manualClock() {
  const pending: { run: () => void; ms: number }[] = []
  return {
    schedule: (run: () => void, ms: number) => {
      const entry = { run, ms }
      pending.push(entry)
      return () => {
        const index = pending.indexOf(entry)
        if (index !== -1) {
          pending.splice(index, 1)
        }
      }
    },
    fire: () => {
      const due = pending.splice(0)
      for (const entry of due) {
        entry.run()
      }
    },
    windows: () => pending.map((entry) => entry.ms),
    pendingCount: () => pending.length
  }
}

function coalescer(clock: ReturnType<typeof manualClock>, windowMs?: number) {
  const emitted: [string, string][] = []
  const instance = createAgentSessionDeltaCoalescer({
    emit: (key, text) => emitted.push([key, text]),
    schedule: clock.schedule,
    ...(windowMs === undefined ? {} : { windowMs })
  })
  return { instance, emitted }
}

describe('agent-session delta coalescer', () => {
  it('folds a burst into one emit carrying the full text, on one shared window', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'he')
    instance.append('item-1', 'llo')
    instance.append('item-2', 'world')

    expect(emitted).toEqual([])
    expect(clock.windows()).toEqual([AGENT_SESSION_DELTA_COALESCE_MS])

    clock.fire()
    expect(emitted).toEqual([
      ['item-1', 'hello'],
      ['item-2', 'world']
    ])
  })

  it('emits the accumulated snapshot again, not the increment, on the next window', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)
    const tail = 'l'.repeat(32)

    instance.append('item-1', 'he')
    clock.fire()
    instance.append('item-1', tail)
    clock.fire()

    expect(emitted).toEqual([
      ['item-1', 'he'],
      ['item-1', `he${tail}`]
    ])
  })

  it('retries a refused lifecycle flush in full, not only once the text grows', () => {
    const clock = manualClock()
    let reject = false
    const emitted: string[] = []
    const instance = createAgentSessionDeltaCoalescer({
      schedule: clock.schedule,
      emit: (_key, text) => !reject && emitted.push(text) > 0
    })

    instance.append('item-1', 'first answer')
    clock.fire()
    instance.append('item-1', '.')
    reject = true
    expect(instance.flushAll()).toBe(false)
    reject = false
    // The growth rule alone would hold one character back from the retry.
    clock.fire()

    expect(emitted).toEqual(['first answer', 'first answer.'])
  })

  it.each([
    { start: 0, interval: 20 },
    { start: 0.25, interval: 20.125 }
  ])('writes a slowly growing long stream within each cap: %j', ({ start, interval }) => {
    let time = start
    const timers: { at: number; run: () => void }[] = []
    const writtenAt: number[] = []
    const instance = createAgentSessionDeltaCoalescer({
      now: () => time,
      schedule: (run, ms) => {
        const timer = { at: time + ms, run }
        timers.push(timer)
        return () => {
          const index = timers.indexOf(timer)
          if (index !== -1) {
            timers.splice(index, 1)
          }
        }
      },
      emit: () => writtenAt.push(time)
    })
    const advanceTo = (at: number): void => {
      for (;;) {
        const next = timers.sort((a, b) => a.at - b.at)[0]
        if (!next || next.at > at) {
          break
        }
        timers.shift()
        time = next.at
        next.run()
      }
      time = at
    }

    instance.append('item-1', 'x'.repeat(1_000))
    // Two characters about every 20 ms: an eighth of 1,000 would take over a second.
    for (let at = start + interval; at <= start + 1_000; at += interval) {
      advanceTo(at)
      instance.append('item-1', 'xx')
    }

    const cap = AGENT_SESSION_STREAMED_TEXT_MAX_GAP_MS
    const firstWrite = start + AGENT_SESSION_DELTA_COALESCE_MS
    expect(writtenAt).toEqual([firstWrite, firstWrite + cap, firstWrite + 2 * cap])
  })

  it('keeps the original cap across clock reads and an early timer callback', () => {
    const clock = manualClock()
    let time = 0.25
    let readStep = 0
    const emitted: string[] = []
    const instance = createAgentSessionDeltaCoalescer({
      now: () => {
        const value = time
        time += readStep
        return value
      },
      schedule: clock.schedule,
      emit: (_key, text) => emitted.push(text)
    })

    const prefix = 'x'.repeat(1_000)
    instance.append('item-1', prefix)
    time = 60.25
    clock.fire()
    time = 80.25
    instance.append('item-1', '.')
    time = 140.25
    readStep = 0.125
    clock.fire()
    expect(clock.windows()).toEqual([319.875])

    // This window closes after the original cap, but before a recomputed cap would.
    readStep = 0
    time = 400.3125
    instance.append('item-1', '.')
    expect(clock.windows()).toEqual([319.875])
    time = 460.125
    clock.fire()
    expect(emitted).toEqual([prefix, `${prefix}..`])
    expect(clock.pendingCount()).toBe(0)
  })

  it('appends ten thousand deltas without rebuilding the retained prefix per token', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    for (let index = 0; index < 10_000; index += 1) {
      instance.append('item-1', 'x')
    }
    clock.fire()

    expect(emitted).toEqual([['item-1', 'x'.repeat(10_000)]])
  })

  it('does not re-emit a stream with no new text', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'hi')
    clock.fire()
    instance.flushAll()

    expect(emitted).toEqual([['item-1', 'hi']])
  })

  it('flushes pending text ahead of a lifecycle event and cancels the window', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'partial')
    instance.flushAll()

    expect(emitted).toEqual([['item-1', 'partial']])
    expect(clock.pendingCount()).toBe(0)
  })

  it('retains dirty state and surfaces admission failure for retry', () => {
    const clock = manualClock()
    let reject = true
    const emitted: string[] = []
    const instance = createAgentSessionDeltaCoalescer({
      schedule: clock.schedule,
      emit: (_key, text) => {
        if (reject) {
          return false
        }
        emitted.push(text)
        return true
      }
    })

    instance.append('item-1', 'retry me')
    expect(instance.flush('item-1')).toBe(false)
    expect(emitted).toEqual([])
    reject = false
    expect(instance.flush('item-1')).toBe(true)
    expect(emitted).toEqual(['retry me'])
  })

  it('does not evict buffered output when flushing the oldest stream is backpressured', () => {
    const clock = manualClock()
    let reject = true
    const emitted: [string, string][] = []
    const instance = createAgentSessionDeltaCoalescer({
      maxStreams: 1,
      schedule: clock.schedule,
      emit: (key, text) => {
        if (reject) {
          return false
        }
        emitted.push([key, text])
        return true
      }
    })

    instance.append('first', 'preserve me')
    expect(instance.append('second', 'new stream')).toBe(false)
    expect(instance.snapshot('first')?.text).toBe('preserve me')
    reject = false
    expect(instance.append('second', 'new stream')).toBe(true)
    expect(emitted).toEqual([['first', 'preserve me']])
  })

  it('drops a forgotten stream without emitting it, because its final body already landed', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'stale')
    instance.append('item-2', 'kept')
    instance.forget('item-1')
    clock.fire()

    expect(emitted).toEqual([['item-2', 'kept']])
  })

  it('emits nothing after dispose, and leaves no timer behind', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'gone')
    instance.dispose()
    clock.fire()

    expect(emitted).toEqual([])
    expect(clock.pendingCount()).toBe(0)
  })

  it('honours an overridden window', () => {
    const clock = manualClock()
    const { instance } = coalescer(clock, 5)

    instance.append('item-1', 'x')

    expect(clock.windows()).toEqual([5])
  })

  it('bounds retained UTF-8 text while continuing to count observed bytes', () => {
    const clock = manualClock()
    const emitted: { text: string; observedBytes: number; truncated: boolean }[] = []
    const instance = createAgentSessionDeltaCoalescer({
      maxRetainedBytes: 40,
      schedule: clock.schedule,
      emit: (_key, _text, snapshot) => emitted.push(snapshot)
    })

    instance.append('item-1', 'éé')
    instance.append('item-1', `${'é'.repeat(20)}more`)
    clock.fire()
    instance.append('item-1', 'ignored')
    clock.fire()

    expect(emitted).toEqual([
      {
        text: 'ééé\n[Orca: streamed output truncated]',
        observedBytes: 48,
        truncated: true
      }
    ])
    expect(instance.snapshot('item-1')).toEqual({
      text: 'ééé\n[Orca: streamed output truncated]',
      observedBytes: 55,
      truncated: true
    })
  })

  it('bounds aggregate retained stream text across independent items', () => {
    const clock = manualClock()
    const emitted = new Map<string, { text: string; observedBytes: number; truncated: boolean }>()
    const instance = createAgentSessionDeltaCoalescer({
      maxRetainedBytes: 80,
      maxTotalRetainedBytes: 120,
      schedule: clock.schedule,
      emit: (key, _text, snapshot) => emitted.set(key, snapshot)
    })

    instance.append('item-1', 'a'.repeat(80))
    instance.append('item-2', 'b'.repeat(80))
    instance.append('item-3', 'c'.repeat(80))
    clock.fire()
    instance.append('item-3', 'c'.repeat(80))
    clock.fire()

    const snapshots = ['item-1', 'item-2', 'item-3'].map((key) => instance.snapshot(key))
    const retainedBytes = snapshots.reduce(
      (total, snapshot) => total + Buffer.byteLength(snapshot?.text ?? '', 'utf8'),
      0
    )
    expect(retainedBytes).toBeLessThanOrEqual(120)
    expect(snapshots.map((snapshot) => snapshot?.observedBytes)).toEqual([80, 80, 160])
    expect(snapshots.map((snapshot) => snapshot?.truncated)).toEqual([false, true, true])
    expect(emitted.get('item-3')).toEqual({ text: '', observedBytes: 80, truncated: true })
  })
})
