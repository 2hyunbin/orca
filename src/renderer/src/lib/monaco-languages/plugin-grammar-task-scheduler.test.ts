import { describe, expect, it } from 'vitest'
import { PluginGrammarTaskScheduler } from './plugin-grammar-task-scheduler'
import { PluginGrammarFailure, type PluginGrammarFailureReason } from './plugin-grammar-failure'

function task() {
  let resolve = (_value: Uint32Array | null) => {}
  const promise = new Promise<Uint32Array | null>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
}

describe('global grammar work budgets and fairness', () => {
  it('reports capacity and typed worker failure without reporting cancelled queued work', async () => {
    const scheduler = new PluginGrammarTaskScheduler(1, 1)
    const failures: PluginGrammarFailureReason[] = []
    const report = (reason: PluginGrammarFailureReason) => failures.push(reason)
    const work = task()
    const active = scheduler.schedule({}, new AbortController().signal, () => work.promise, report)
    const cancelled = new AbortController()
    const queued = scheduler.schedule({}, cancelled.signal, async () => null, report)
    await scheduler.schedule({}, new AbortController().signal, async () => null, report)
    expect(failures).toEqual(['capacity'])
    cancelled.abort()
    await queued
    const rejected = scheduler.schedule(
      {},
      new AbortController().signal,
      async () => {
        throw new PluginGrammarFailure('budget')
      },
      report
    )
    work.resolve(null)
    await active
    await rejected
    expect(failures).toEqual(['capacity', 'budget'])
  })

  it('allows two owners while serializing each owner and gives another grammar a turn', async () => {
    const scheduler = new PluginGrammarTaskScheduler()
    const a = {},
      b = {},
      c = {}
    const signal = new AbortController().signal
    const first = task(),
      second = task(),
      third = task(),
      fourth = task()
    const starts: string[] = []
    const run = (name: string, work: ReturnType<typeof task>) => () => {
      starts.push(name)
      return work.promise
    }
    const jobs = [
      scheduler.schedule(a, signal, run('a1', first)),
      scheduler.schedule(a, signal, run('a2', fourth)),
      scheduler.schedule(b, signal, run('b', second)),
      scheduler.schedule(c, signal, run('c', third))
    ]
    await flush()
    expect(starts).toEqual(['a1', 'b'])
    second.resolve(null)
    await flush()
    expect(starts).toEqual(['a1', 'b', 'c'])
    first.resolve(null)
    await flush()
    expect(starts).toEqual(['a1', 'b', 'c', 'a2'])
    third.resolve(null)
    fourth.resolve(null)
    await Promise.all(jobs)
  })

  it('bounds pending work, cancels queued jobs without running them, and releases capacity after failures', async () => {
    const scheduler = new PluginGrammarTaskScheduler(1, 1)
    const first = task()
    const active = scheduler.schedule({}, new AbortController().signal, () => first.promise)
    const cancelled = new AbortController()
    let ran = false
    const queued = scheduler.schedule({}, cancelled.signal, async () => {
      ran = true
      return null
    })
    expect(
      await scheduler.schedule({}, new AbortController().signal, async () => new Uint32Array([1]))
    ).toBeNull()
    cancelled.abort()
    expect(await queued).toBeNull()
    expect(ran).toBe(false)
    const failed = scheduler.schedule({}, new AbortController().signal, async () => {
      throw new Error('fixture failure')
    })
    first.resolve(null)
    await active
    expect(await failed).toBeNull()
    expect(
      await scheduler.schedule({}, new AbortController().signal, async () => new Uint32Array([2]))
    ).toEqual(new Uint32Array([2]))
  })

  it('holds an active worker permit until its cancellation actually settles', async () => {
    const scheduler = new PluginGrammarTaskScheduler(1, 8)
    const first = task()
    const controller = new AbortController()
    const active = scheduler.schedule({}, controller.signal, () => first.promise)
    let ran = false
    const next = scheduler.schedule({}, new AbortController().signal, async () => {
      ran = true
      return null
    })
    await flush()
    controller.abort()
    await flush()
    expect(ran).toBe(false)
    first.resolve(new Uint32Array([1]))
    expect(await active).toBeNull()
    await next
    expect(ran).toBe(true)
  })
})
