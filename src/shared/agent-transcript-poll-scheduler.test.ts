import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const watchers = vi.hoisted(() => ({
  bound: true,
  entries: Array<{
    wake: () => void
    error: () => void
    bind: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    rebind: boolean
  }>()
}))
vi.mock('./transcript-native-watcher', () => ({
  createTranscriptNativeWatcher: (_path: string, wake: () => void, error: () => void) => {
    const entry = {
      wake,
      error,
      rebind: true,
      bind: vi.fn(() => {
        entry.rebind = !watchers.bound
        return watchers.bound
      }),
      dispose: vi.fn()
    }
    watchers.entries.push(entry)
    return { bind: entry.bind, dispose: entry.dispose, needsRebind: () => entry.rebind }
  }
}))
import { AgentTranscriptPollScheduler } from './agent-transcript-poll-scheduler'
import { readJsonlCursor, type JsonlCursor } from './codex-rollout-jsonl-cursor'

describe('host transcript wakeup budget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    watchers.bound = true
    watchers.entries.length = 0
  })
  afterEach(() => vi.useRealTimers())

  it.each([10, 100])(
    'bounds upstream deadline visits and real incremental IO for %i panes',
    (count) => {
      const dir = mkdtempSync(join(tmpdir(), 'transcript-deadlines-'))
      const captured = readFileSync(
        join(__dirname, '__fixtures__/claude-permission-escape.jsonl'),
        'utf8'
      ).split('\n')
      const visits = [0, 0]
      class CountedMap<V> extends Map<string, V> {
        override *values(): MapIterator<V> {
          for (const value of super.values()) {
            visits[0]++
            yield value
          }
        }
        override *[Symbol.iterator](): MapIterator<[string, V]> {
          for (const entry of super[Symbol.iterator]()) {
            visits[1]++
            yield entry
          }
        }
      }
      let bytes = 0
      const seen: unknown[] = []
      const scheduler = new AgentTranscriptPollScheduler<JsonlCursor>(1_000, (key, value) => {
        const progress = { complete: false, bytes: 0 }
        seen.push(...(readJsonlCursor(value, undefined, undefined, progress) ?? []))
        bytes += progress.bytes
        scheduler.schedule(key, value, value.filePath)
      })
      const cursor = (i: number) => ({ filePath: join(dir, `${i}.jsonl`), offset: 0, carry: '' })
      Object.defineProperty(scheduler['deadlines'], 'entries', { value: new CountedMap() })
      const parse = vi.spyOn(JSON, 'parse')
      try {
        for (let i = 0; i < count; i++) {
          const value = cursor(i)
          writeFileSync(value.filePath, `${captured[0]}\n`)
          scheduler.schedule(String(i), value, value.filePath)
        }
        expect(visits).toEqual([(count * (count + 1)) / 2, 0]) // External admission remains quadratic in aggregate.
        vi.advanceTimersByTime(1_000)
        expect(seen).toHaveLength(count)
        bytes = 0
        visits.fill(0)
        parse.mockClear()
        vi.advanceTimersByTime(60_000)
        expect(visits).toEqual([12 * count, 24 * count]) // P+D+R=3P per recurring flush.
        expect([bytes, parse.mock.calls.length]).toEqual([0, 0])
        expect(watchers.entries).toHaveLength(count)
        visits.fill(0)
        appendFileSync(cursor(0).filePath, `${captured[1]}\n`)
        for (let i = 0; i < 100; i++) {
          watchers.entries[0]!.wake()
        }
        expect(visits).toEqual([count, 0]) // One coalesced external mutation.
        visits.fill(0)
        vi.advanceTimersByTime(1_000)
        expect([bytes, parse.mock.calls.length, seen.length]).toEqual([
          Buffer.byteLength(`${captured[1]}\n`),
          1,
          count + 1
        ])
        expect(visits[0]! + visits[1]!).toBeLessThanOrEqual(count + 1 + count)
        expect(seen.at(-1)).toEqual(JSON.parse(captured[1]!))
        expect(vi.getTimerCount()).toBe(1)
        visits.fill(0)
        for (let i = 0; i < count; i++) {
          scheduler.clear(String(i))
        }
        expect(visits).toEqual([(count * (count - 1)) / 2, 0])
        expect(watchers.entries.every((entry) => entry.dispose.mock.calls.length === 1)).toBe(true)
        for (const watcher of watchers.entries) {
          watcher.wake()
        }
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        scheduler.clearAll()
        parse.mockRestore()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it('coalesces a stream without postponing reads and reuses the latest hook', () => {
    const seen: string[] = []
    const scheduler = new AgentTranscriptPollScheduler<string>(500, (key, value) => {
      seen.push(value)
      scheduler.schedule(key, value, '/rollout.jsonl')
    })
    scheduler.schedule('pane', 'first', '/rollout.jsonl')
    vi.advanceTimersByTime(500)
    const watch = watchers.entries[0]!
    for (let i = 0; i < 1_000; i++) {
      watch.wake()
      scheduler.schedule('pane', `hook-${i}`, '/rollout.jsonl')
    }
    expect(watchers.entries).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(500)
    expect(seen).toEqual(['first', 'hook-999'])
    scheduler.clear('pane')
    watch.wake()
    expect(vi.getTimerCount()).toBe(0)
    expect(watch.dispose).toHaveBeenCalledOnce()
  })

  it('keeps unreadable watches on the old cadence but bounds bind retries', () => {
    watchers.bound = false
    let reads = 0
    const scheduler = new AgentTranscriptPollScheduler<number>(500, (key, value) => {
      reads++
      scheduler.schedule(key, value, '/missing.jsonl')
    })
    scheduler.schedule('pane', 1, '/missing.jsonl')
    vi.advanceTimersByTime(10_000)
    expect(reads).toBe(20)
    expect(watchers.entries[0]!.bind).toHaveBeenCalledTimes(3)
    scheduler.clearAll()
  })

  it('rebinds after rename or error and drops replaced watches and stale callbacks', () => {
    const seen: number[] = []
    const scheduler = new AgentTranscriptPollScheduler<number>(500, (key, value) => {
      seen.push(value)
      scheduler.schedule(key, value, '/new.jsonl')
    })
    scheduler.schedule('pane', 1, '/old.jsonl')
    const old = watchers.entries[0]!
    scheduler.schedule('pane', 2, '/new.jsonl')
    old.wake()
    expect(old.dispose).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(500)
    const current = watchers.entries[1]!
    current.rebind = true
    current.wake()
    vi.advanceTimersByTime(500)
    expect(current.bind).toHaveBeenCalledTimes(2)
    current.rebind = true
    current.error()
    vi.advanceTimersByTime(500)
    expect(current.bind).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([2, 2, 2])
    scheduler.clearAll()
  })

  it('retains polling for children and WSL UNC and releases abandoned callbacks', () => {
    const seen = vi.fn()
    const scheduler = new AgentTranscriptPollScheduler<number>(500, seen)
    scheduler.schedule('child', 1)
    scheduler.schedule('wsl', 2, '\\\\wsl.localhost\\Ubuntu\\rollout.jsonl')
    scheduler.schedule('root', 3, '/rollout.jsonl')
    vi.advanceTimersByTime(500)
    expect(seen).toHaveBeenCalledTimes(3)
    expect(watchers.entries).toHaveLength(1)
    expect(watchers.entries[0]!.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
