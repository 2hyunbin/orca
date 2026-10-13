import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_GRAMMAR_DOCUMENT_DEADLINE_MS,
  PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS,
  PLUGIN_GRAMMAR_QUEUE_LIMIT,
  type PluginGrammarRequest
} from '../../../../shared/plugins/plugin-grammar-protocol'
import { PluginGrammarWorkerClient, type PluginGrammarWorker } from './plugin-grammar-worker-client'

class WorkerFixture implements PluginGrammarWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  requests: PluginGrammarRequest[] = []
  terminate = vi.fn()
  postMessage(request: PluginGrammarRequest): void {
    this.requests.push(request)
  }
  respond(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
}

function fixture() {
  const workers: WorkerFixture[] = []
  const client = new PluginGrammarWorkerClient('source.example', [], () => {
    const worker = new WorkerFixture()
    workers.push(worker)
    return worker
  })
  return { client, workers }
}

function complete(worker: WorkerFixture, textLength = 1): void {
  worker.respond({
    ...identity(worker),
    type: 'complete',
    data: new Uint32Array([0, 0, textLength, 2, 0])
  })
}

function identity(worker: WorkerFixture) {
  const request = worker.requests.at(-1)
  if (!request) {
    throw new Error('No worker request')
  }
  return { id: request.id, generation: request.generation, version: request.version }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('killable grammar worker', () => {
  it('reports checked size/capacity refusals while cancellation remains a neutral result', async () => {
    const { client, workers } = fixture()
    await expect(
      client.tokenizeChecked('x'.repeat(500_001), 1, 1, new AbortController().signal)
    ).rejects.toMatchObject({ reason: 'size' })
    expect(workers).toHaveLength(0)
    const pending = Array.from({ length: PLUGIN_GRAMMAR_QUEUE_LIMIT + 1 }, () =>
      client.tokenizeChecked('x', 1, 1, new AbortController().signal)
    )
    await expect(
      client.tokenizeChecked('x', 1, 1, new AbortController().signal)
    ).rejects.toMatchObject({ reason: 'capacity' })
    client.dispose()
    expect(await Promise.all(pending)).toEqual(pending.map(() => null))
    const next = fixture()
    const controller = new AbortController()
    const cancelled = next.client.tokenizeChecked('x', 1, 1, controller.signal)
    controller.abort()
    expect(await cancelled).toBeNull()
    next.client.dispose()
  })

  it('distinguishes a killed worker budget from invalid output and recreates healthy work after each', async () => {
    vi.useFakeTimers()
    const { client, workers } = fixture()
    const timedOut = client
      .tokenizeChecked('x', 1, 1, new AbortController().signal)
      .catch((error) => error)
    await vi.advanceTimersByTimeAsync(PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS)
    expect(await timedOut).toMatchObject({ reason: 'budget' })
    const rejected = client
      .tokenizeChecked('x', 2, 1, new AbortController().signal)
      .catch((error) => error)
    complete(workers[1], 2)
    expect(await rejected).toMatchObject({ reason: 'worker' })
    expect(workers[1].terminate).toHaveBeenCalledOnce()
    const healthy = client.tokenizeChecked('x', 3, 1, new AbortController().signal)
    complete(workers[2])
    expect(await healthy).toEqual(new Uint32Array([0, 0, 1, 2, 0]))
    client.dispose()
  })

  it('kills a worker that misses progress and recreates it for the next document', async () => {
    vi.useFakeTimers()
    const { client, workers } = fixture()
    const first = client.tokenize('x', 1, 1, new AbortController().signal)
    const second = client.tokenize('y', 2, 1, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS)
    expect(await first).toBeNull()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(workers).toHaveLength(2)
    complete(workers[1])
    expect(await second).toEqual(new Uint32Array([0, 0, 1, 2, 0]))
    client.dispose()
  })

  it('cancels active and queued requests without resurrecting stale worker results', async () => {
    const { client, workers } = fixture()
    const firstAbort = new AbortController()
    const queuedAbort = new AbortController()
    const first = client.tokenize('x', 1, 4, firstAbort.signal)
    const receiveOld = workers[0].onmessage
    const second = client.tokenize('y', 1, 4, queuedAbort.signal)
    queuedAbort.abort()
    expect(await second).toBeNull()
    firstAbort.abort()
    expect(await first).toBeNull()
    const third = client.tokenize('z', 2, 5, new AbortController().signal)
    receiveOld?.(
      new MessageEvent('message', {
        data: { ...identity(workers[0]), type: 'complete', data: new Uint32Array([0, 0, 1, 2, 0]) }
      })
    )
    complete(workers[1])
    expect(await third).not.toBeNull()
    client.dispose()
  })

  it('does not accept wrong generation, version, or out-of-model tokens', async () => {
    const { client, workers } = fixture()
    const result = client.tokenize('x', 3, 4, new AbortController().signal)
    workers[0].respond({
      ...identity(workers[0]),
      generation: 5,
      type: 'complete',
      data: new Uint32Array([0, 0, 1, 2, 0])
    })
    workers[0].respond({
      ...identity(workers[0]),
      version: 2,
      type: 'complete',
      data: new Uint32Array([0, 0, 1, 2, 0])
    })
    complete(workers[0], 2)
    expect(await result).toBeNull()
    client.dispose()
  })

  it('settles all work when disposed, including an already aborted signal', async () => {
    const { client, workers } = fixture()
    const controller = new AbortController()
    controller.abort()
    expect(await client.tokenize('x', 1, 1, controller.signal)).toBeNull()
    const first = client.tokenize('x', 1, 1, new AbortController().signal)
    const second = client.tokenize('y', 1, 1, new AbortController().signal)
    client.dispose()
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(await client.tokenize('x', 1, 1, new AbortController().signal)).toBeNull()
  })

  it('bounds the backlog and rejects oversized models before starting a worker', async () => {
    const { client, workers } = fixture()
    expect(
      await client.tokenize('x'.repeat(500_001), 1, 1, new AbortController().signal)
    ).toBeNull()
    expect(
      await client.tokenize('\n'.repeat(20_000), 1, 1, new AbortController().signal)
    ).toBeNull()
    expect(workers).toHaveLength(0)
    const pending = Array.from({ length: PLUGIN_GRAMMAR_QUEUE_LIMIT + 1 }, () =>
      client.tokenize('x', 1, 1, new AbortController().signal)
    )
    expect(await client.tokenize('x', 1, 1, new AbortController().signal)).toBeNull()
    client.dispose()
    expect(await Promise.all(pending)).toEqual(pending.map(() => null))
  })

  it('enforces a total document deadline even if the worker keeps sending progress', async () => {
    vi.useFakeTimers()
    const { client, workers } = fixture()
    const result = client.tokenize('x', 1, 1, new AbortController().signal)
    for (let elapsed = 0; elapsed < PLUGIN_GRAMMAR_DOCUMENT_DEADLINE_MS; elapsed += 1_000) {
      workers[0].respond({ ...identity(workers[0]), type: 'progress' })
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(await result).toBeNull()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    client.dispose()
  })
})
