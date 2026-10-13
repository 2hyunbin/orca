import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginViewerDocumentInfo,
  PluginViewerReadRequest,
  PluginViewerReadResponse
} from './plugin-viewer-document'
import { deferred } from './plugin-viewer-document-test-fixture'
import { PluginViewerWorkerHost, type PluginViewerWorkerPort } from './plugin-viewer-worker-host'
import type { PluginViewerWorkerResponse } from './plugin-viewer-worker-protocol'

const binding = {
  version: 1,
  sessionId: 'bfbfcd39-ed71-4a30-a22c-d74fa75d5887',
  generation: 2
} as const
const document: PluginViewerDocumentInfo = {
  documentHandle: 'bfbfcd39-ed71-4a30-a22c-d74fa75d5888',
  name: 'values.custom',
  size: 3,
  revision: 'bfbfcd39-ed71-4a30-a22c-d74fa75d5889',
  features: { rangeRead: true, watch: false }
}
const viewport = { kind: 'text', startLine: 0, lineCount: 1 } as const
const response: PluginViewerReadResponse = {
  ok: true,
  result: { revision: document.revision, bytesRead: 3, contentBase64: 'YWJj', eof: true }
}

function createHost(
  read: (
    request: PluginViewerReadRequest,
    signal: AbortSignal
  ) => Promise<PluginViewerReadResponse> = async () => response,
  respondToPulses = true
) {
  const listeners = new Map<string, Set<(event: MessageEvent<unknown>) => void>>()
  const worker: PluginViewerWorkerPort = {
    postMessage: vi.fn<(message: PluginViewerWorkerResponse) => void>((message) => {
      if (message.type === 'pulse' && respondToPulses) {
        emit({ ...binding, type: 'alive', pulse: message.pulse })
      }
    }),
    terminate: vi.fn(),
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set()
      entries.add(listener)
      listeners.set(type, entries)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    }
  }
  const onReady = vi.fn()
  const onView = vi.fn()
  const onError = vi.fn()
  const readFile = vi.fn(read)
  const host = new PluginViewerWorkerHost(worker, {
    binding,
    document,
    read: readFile,
    onReady,
    onView,
    onError
  })
  const emit = (message: unknown): void => {
    const event = new MessageEvent<unknown>('message', { data: message })
    for (const listener of listeners.get('message') ?? []) {
      listener(event)
    }
  }
  const ready = (): void =>
    emit({ ...binding, type: 'ready', surface: { kind: 'text', lineCount: 10 } })
  return { host, worker, readFile, onReady, onView, onError, emit, ready, listeners }
}

describe('viewer worker authority and lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives the worker document metadata without a host handle or path', () => {
    const test = createHost()
    expect(test.worker.postMessage).toHaveBeenCalledWith({
      ...binding,
      type: 'initialize',
      document: {
        name: document.name,
        size: 3,
        revision: document.revision,
        features: document.features
      }
    })
    test.host.dispose()
  })

  it('binds range reads to the host-created document handle and revision', async () => {
    const test = createHost()
    test.emit({ ...binding, type: 'read', requestId: 1, position: 0, length: 3 })
    await vi.runAllTicks()
    await Promise.resolve()
    expect(test.readFile).toHaveBeenCalledWith(
      {
        documentHandle: document.documentHandle,
        revision: document.revision,
        position: 0,
        length: 3
      },
      expect.any(AbortSignal)
    )
    expect(test.worker.postMessage).toHaveBeenLastCalledWith({
      ...binding,
      type: 'read-result',
      requestId: 1,
      response
    })
    test.ready()
    expect(test.onReady).toHaveBeenCalledOnce()
    test.host.dispose()
  })

  it.each([
    { sessionId: 'bfbfcd39-ed71-4a30-a22c-d74fa75d5886' },
    { generation: 3 },
    { version: 2 },
    { documentHandle: document.documentHandle },
    { owner: 'forged' },
    { position: 4 }
  ])('rejects forged ownership or an invalid range before reading: %j', (change) => {
    const test = createHost()
    test.emit({ ...binding, type: 'read', requestId: 1, position: 0, length: 3, ...change })
    expect(test.readFile).not.toHaveBeenCalled()
    expect(test.onError).toHaveBeenCalledOnce()
    expect(test.worker.terminate).toHaveBeenCalledOnce()
  })

  it('limits concurrent byte reads and rejects duplicate request IDs', () => {
    const gate = deferred<PluginViewerReadResponse>()
    const test = createHost(() => gate.promise)
    test.emit({ ...binding, type: 'read', requestId: 1, position: 0, length: 3 })
    test.emit({ ...binding, type: 'read', requestId: 2, position: 0, length: 3 })
    test.emit({ ...binding, type: 'read', requestId: 3, position: 0, length: 3 })
    expect(test.readFile).toHaveBeenCalledTimes(2)
    expect(test.onError).toHaveBeenCalledWith('limit_exceeded')
    const duplicate = createHost(() => gate.promise)
    duplicate.emit({ ...binding, type: 'read', requestId: 1, position: 0, length: 3 })
    duplicate.emit({ ...binding, type: 'read', requestId: 1, position: 0, length: 3 })
    expect(duplicate.readFile).toHaveBeenCalledOnce()
    expect(duplicate.onError).toHaveBeenCalledWith('invalid_output')
    gate.resolve(response)
  })

  it('cancels late I/O and removes every worker listener on disposal', async () => {
    const gate = deferred<PluginViewerReadResponse>()
    const test = createHost((_request, signal) => {
      expect(signal.aborted).toBe(false)
      return gate.promise
    })
    test.emit({ ...binding, type: 'read', requestId: 1, position: 0, length: 3 })
    const signal = test.readFile.mock.calls[0]?.[1]
    test.host.dispose()
    expect(signal?.aborted).toBe(true)
    gate.resolve(response)
    await Promise.resolve()
    test.ready()
    expect(test.worker.postMessage).toHaveBeenCalledTimes(1)
    expect(test.onReady).not.toHaveBeenCalled()
    expect(test.onError).not.toHaveBeenCalled()
    expect([...test.listeners.values()].every((set) => set.size === 0)).toBe(true)
    test.host.dispose()
    expect(test.worker.terminate).toHaveBeenCalledOnce()
  })

  it.each([
    { revision: 'bfbfcd39-ed71-4a30-a22c-d74fa75d5886' },
    { eof: false },
    { bytesRead: 0, contentBase64: '' }
  ])('withdraws a read whose host result is inconsistent: %j', async (change) => {
    const test = createHost(async () => ({ ok: true, result: { ...response.result, ...change } }))
    test.emit({ ...binding, type: 'read', requestId: 1, position: 0, length: 3 })
    await Promise.resolve()
    expect(test.worker.postMessage).toHaveBeenCalledTimes(1)
    expect(test.onError).toHaveBeenCalledOnce()
  })

  it('preserves closed host errors without exposing thrown host details', async () => {
    const denied = createHost(async () => ({ ok: false, error: 'unauthorized' }))
    denied.emit({ ...binding, type: 'read', requestId: 1, position: 0, length: 3 })
    await Promise.resolve()
    expect(denied.onError).toHaveBeenCalledWith('unauthorized')
    const thrown = createHost(async () => {
      throw new Error('/private/host/secret')
    })
    thrown.emit({ ...binding, type: 'read', requestId: 1, position: 0, length: 3 })
    await Promise.resolve()
    expect(thrown.onError).toHaveBeenCalledWith('read_failed')
  })

  it('retires a parser on an absolute deadline even while it emits valid reads', async () => {
    const test = createHost()
    for (let requestId = 1; requestId <= 3; requestId++) {
      test.emit({ ...binding, type: 'read', requestId, position: 0, length: 3 })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(3_000)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(test.onError).toHaveBeenCalledWith('unresponsive')
    expect(test.worker.terminate).toHaveBeenCalledOnce()
  })

  it('uses a separate render deadline and coalesces viewports without displaying superseded output', () => {
    const test = createHost()
    test.ready()
    expect(test.host.requestViewport(viewport)).toBe(true)
    for (let startLine = 1; startLine <= 5; startLine++) {
      test.host.requestViewport({ ...viewport, startLine })
    }
    test.emit({
      ...binding,
      type: 'view',
      requestId: 1,
      view: { kind: 'text', startLine: 0, lines: ['old'] }
    })
    expect(test.onView).not.toHaveBeenCalled()
    expect(test.worker.postMessage).toHaveBeenLastCalledWith({
      ...binding,
      type: 'viewport',
      requestId: 2,
      viewport: { ...viewport, startLine: 5 }
    })
    test.emit({
      ...binding,
      type: 'view',
      requestId: 2,
      view: { kind: 'text', startLine: 5, lines: ['current'] }
    })
    expect(test.onView).toHaveBeenCalledWith({ kind: 'text', startLine: 5, lines: ['current'] })
    test.host.requestViewport(viewport)
    vi.advanceTimersByTime(2_000)
    expect(test.onError).toHaveBeenCalledWith('unresponsive')
  })

  it.each([{ requestId: 2 }, { view: { kind: 'text', startLine: 1, lines: ['wrong'] } }])(
    'rejects output for a different viewport: %j',
    (change) => {
      const test = createHost()
      test.ready()
      test.host.requestViewport(viewport)
      test.emit({
        ...binding,
        type: 'view',
        requestId: 1,
        view: { kind: 'text', startLine: 0, lines: ['valid'] },
        ...change
      })
      expect(test.onView).not.toHaveBeenCalled()
      expect(test.onError).toHaveBeenCalledWith('invalid_output')
    }
  )

  it('rejects forged heartbeat and unsolicited ready or output messages', () => {
    for (const message of [
      { type: 'heartbeat' },
      { type: 'view', requestId: 1, view: { kind: 'text', startLine: 0, lines: [] } }
    ]) {
      const test = createHost()
      test.emit({ ...binding, ...message })
      expect(test.onError).toHaveBeenCalledWith('invalid_output')
    }
    const test = createHost()
    test.ready()
    test.ready()
    expect(test.onError).toHaveBeenCalledWith('invalid_output')
  })

  it('caps valid message traffic without resetting the parser deadline', async () => {
    const test = createHost()
    for (let requestId = 1; requestId <= 513; requestId++) {
      test.emit({ ...binding, type: 'read', requestId, position: 0, length: 3 })
      await Promise.resolve()
    }
    expect(test.readFile).toHaveBeenCalledTimes(512)
    expect(test.onError).toHaveBeenCalledWith('limit_exceeded')
    expect(test.worker.terminate).toHaveBeenCalledOnce()
  })

  it('retires a busy worker even after initialization is complete and no view is pending', () => {
    const test = createHost(undefined, false)
    test.ready()
    vi.advanceTimersByTime(2_249)
    expect(test.onError).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(test.onError).toHaveBeenCalledWith('unresponsive')
    expect(test.worker.terminate).toHaveBeenCalledOnce()
  })

  it('does not let a guessed or replayed pulse reset liveness', () => {
    const test = createHost(undefined, false)
    vi.advanceTimersByTime(250)
    const calls = vi.mocked(test.worker.postMessage).mock.calls
    const pulse = calls.at(-1)?.[0]
    if (pulse?.type !== 'pulse') {
      throw new Error('expected pulse')
    }
    test.emit({ ...binding, type: 'alive', pulse: pulse.pulse })
    expect(test.onError).not.toHaveBeenCalled()
    test.emit({ ...binding, type: 'alive', pulse: pulse.pulse })
    expect(test.onError).toHaveBeenCalledWith('invalid_output')
  })

  it('keeps liveness independent of the ordinary control budget', () => {
    const test = createHost()
    test.ready()
    for (let index = 1; index <= 180; index++) {
      test.host.requestViewport(viewport)
      test.emit({
        ...binding,
        type: 'view',
        requestId: index,
        view: { kind: 'text', startLine: 0, lines: ['value'] }
      })
    }
    expect(test.onView).toHaveBeenCalledTimes(179)
    expect(test.onError).toHaveBeenCalledWith('limit_exceeded')
  })
})
