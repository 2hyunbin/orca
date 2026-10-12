import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_TEARDOWN_MS,
  WorkerThreadChildProcessHost,
  type WorkerThreadChildProcess
} from './worker-thread-child-process'
import type {
  WorkerThreadChildEvent,
  WorkerThreadChildRequest
} from './worker-thread-child-process-protocol'

// A worker_threads stand-in: records posted requests and lets a test emit
// message/error/exit without a built worker bundle.
class FakeWorker {
  posted: WorkerThreadChildRequest[] = []
  terminated = false
  private listeners = new Map<string | symbol, Set<(...args: unknown[]) => void>>()

  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return this
  }

  off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeAllListeners(): this {
    this.listeners.clear()
    return this
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }

  postMessage(request: WorkerThreadChildRequest): void {
    this.posted.push(request)
  }

  emit(event: string, arg: unknown): void {
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(arg)
    }
  }

  send(event: WorkerThreadChildEvent): void {
    this.emit('message', event)
  }
}

function makeHost(workers: FakeWorker[], log = vi.fn()): WorkerThreadChildProcessHost {
  return new WorkerThreadChildProcessHost(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  }, log)
}

const SPEC = { program: 'codex', args: ['app-server'] }

function recordEvents(child: WorkerThreadChildProcess): unknown[][] {
  const events: unknown[][] = []
  child.on('spawn', () => events.push(['spawn', child.pid]))
  child.on('error', (error: NodeJS.ErrnoException) =>
    events.push(['error', error.message, error.code])
  )
  child.on('exit', (code, signal) => events.push(['exit', code, signal]))
  child.on('close', (code, signal) => events.push(['close', code, signal]))
  child.stdout.on('data', (chunk: Buffer) => events.push(['stdout', chunk.toString()]))
  child.stderr.on('data', (chunk: Buffer) => events.push(['stderr', chunk.toString()]))
  return events
}

describe('WorkerThreadChildProcessHost', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts the spawn to the worker and replays its events on the proxy', () => {
    const workers: FakeWorker[] = []
    const child = makeHost(workers).spawn(SPEC)
    const events = recordEvents(child)

    expect(workers[0].posted).toEqual([{ type: 'spawn', id: child.id, spec: SPEC }])
    workers[0].send({ type: 'spawn', id: child.id, pid: 4242 })
    workers[0].send({
      type: 'stdout',
      id: child.id,
      chunk: new TextEncoder().encode('{"id":1}\n')
    })
    workers[0].send({
      type: 'stderr',
      id: child.id,
      chunk: new TextEncoder().encode('warn')
    })
    workers[0].send({ type: 'exit', id: child.id, code: 0, signal: null })
    workers[0].send({ type: 'close', id: child.id, code: 0, signal: null })

    // Data must arrive as a Buffer: the RPC reader calls chunk.toString().
    expect(events).toEqual([
      ['spawn', 4242],
      ['stdout', '{"id":1}\n'],
      ['stderr', 'warn'],
      ['exit', 0, null],
      ['close', 0, null]
    ])
    expect(child.exitCode).toBe(0)
  })

  it('forwards stdin writes, stdin end and kill for the right child', () => {
    const workers: FakeWorker[] = []
    const host = makeHost(workers)
    host.spawn(SPEC)
    const child = host.spawn(SPEC)

    child.stdin.write('hello\n')
    child.stdin.end()
    expect(child.kill('SIGTERM')).toBe(true)

    expect(workers).toHaveLength(1)
    expect(workers[0].posted.slice(2)).toEqual([
      { type: 'stdin-write', id: child.id, data: 'hello\n' },
      { type: 'stdin-end', id: child.id },
      { type: 'kill', id: child.id, signal: 'SIGTERM' }
    ])
  })

  it('surfaces errors and stdin errors with their errno code', () => {
    const workers: FakeWorker[] = []
    const child = makeHost(workers).spawn(SPEC)
    const events = recordEvents(child)
    const stdinErrors: string[] = []
    child.stdin.on('error', (error: NodeJS.ErrnoException) => stdinErrors.push(`${error.code}`))

    workers[0].send({
      type: 'error',
      id: child.id,
      error: { message: 'spawn codex ENOENT', code: 'ENOENT' }
    })
    workers[0].send({
      type: 'stdin-error',
      id: child.id,
      error: { message: 'EPIPE', code: 'EPIPE' }
    })

    expect(events).toEqual([['error', 'spawn codex ENOENT', 'ENOENT']])
    expect(stdinErrors).toEqual(['EPIPE'])
  })

  it('drops a late error nobody listens for instead of throwing on the main loop', () => {
    const workers: FakeWorker[] = []
    const child = makeHost(workers).spawn(SPEC)

    expect(() =>
      workers[0].send({
        type: 'error',
        id: child.id,
        error: { message: 'late' }
      })
    ).not.toThrow()
  })

  it('fails closed, after listeners can attach, when no worker can be started', async () => {
    const log = vi.fn()
    const host = new WorkerThreadChildProcessHost(() => {
      throw new Error('entry missing')
    }, log)

    const child = host.spawn(SPEC)
    const events = recordEvents(child)
    expect(events).toEqual([])
    await new Promise((resolve) => process.nextTick(resolve))

    expect(events).toEqual([
      ['error', 'Child process worker is unavailable', undefined],
      ['exit', -1, null],
      ['close', -1, null]
    ])
    expect(child.exitCode).toBe(-1)
    expect(child.kill()).toBe(false)
    host.spawn(SPEC)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('orphans live children without a close when the worker dies, then respawns', () => {
    const workers: FakeWorker[] = []
    const host = makeHost(workers)
    const child = host.spawn(SPEC)
    const events = recordEvents(child)
    workers[0].send({ type: 'spawn', id: child.id, pid: 77 })

    workers[0].emit('exit', 1)

    // No 'close': the real process may outlive the worker, so termination must escalate by pid.
    expect(events).toEqual([
      ['spawn', 77],
      ['error', 'Child process worker exited with code 1', undefined]
    ])
    expect(child.exitCode).toBeNull()
    expect(workers[0].terminated).toBe(true)

    host.spawn(SPEC)
    expect(workers).toHaveLength(2)
  })

  it('kills an orphan by pid once its worker is gone', () => {
    const workers: FakeWorker[] = []
    const killOrphan = vi.fn(() => true)
    const child = makeHost(workers).spawn(SPEC, { killOrphan })
    workers[0].send({ type: 'spawn', id: child.id, pid: 77 })
    workers[0].emit('exit', 1)

    expect(child.kill('SIGKILL')).toBe(true)

    expect(killOrphan).toHaveBeenCalledWith(77, 'SIGKILL')
    // The dead worker must not be the one asked to kill.
    expect(workers[0].posted.map((request) => request.type)).toEqual(['spawn'])
  })

  it('reports an orphan without a known pid as unkillable instead of throwing', () => {
    const workers: FakeWorker[] = []
    const killOrphan = vi.fn(() => true)
    const child = makeHost(workers).spawn(SPEC, { killOrphan })
    workers[0].emit('error', new Error('worker crashed'))

    expect(() => child.kill()).not.toThrow()
    expect(child.kill()).toBe(false)
    expect(killOrphan).not.toHaveBeenCalled()
  })

  it('tears the idle worker down only after the last child closes', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const host = makeHost(workers)
    const first = host.spawn(SPEC)
    const second = host.spawn(SPEC)

    workers[0].send({ type: 'close', id: first.id, code: 0, signal: null })
    await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS)
    expect(workers[0].terminated).toBe(false)

    workers[0].send({ type: 'close', id: second.id, code: 0, signal: null })
    await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS - 1)
    expect(workers[0].terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(workers[0].terminated).toBe(true)
  })

  it('cancels a pending idle teardown when a new child spawns', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const host = makeHost(workers)
    const first = host.spawn(SPEC)
    workers[0].send({ type: 'close', id: first.id, code: 0, signal: null })

    await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS - 1)
    host.spawn(SPEC)
    await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS)

    expect(workers[0].terminated).toBe(false)
    expect(workers).toHaveLength(1)
  })
})
