import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import {
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'

const INPUT = { identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' }

function startup(routes: Parameters<typeof fakeCodex>[0] = {}) {
  const events: CodexStructuredSessionEvent[] = []
  const codex = fakeCodex(routes)
  const adapter = adapterFor(codex, {}, [], { onEvent: (event) => events.push(event) })
  return { events, codex, adapter }
}

async function open(
  adapter: ReturnType<typeof adapterFor>,
  acquisitionGeneration: string | undefined,
  signal = new AbortController().signal
) {
  return adapter.open({
    sessionId: 'session-1',
    fence: 7,
    acquisitionGeneration: acquisitionGeneration ?? null,
    signal
  })
}

describe('Codex host-awaited open', () => {
  it('publishes its process before initialize and returns protocol facts only after thread/start', async () => {
    const initialized = Promise.withResolvers<unknown>()
    const threaded = Promise.withResolvers<unknown>()
    const { adapter, codex, events } = startup({
      initialize: () => initialized.promise,
      'thread/start': () => threaded.promise
    })
    const committed = Promise.withResolvers<void>()
    const onSpawned = vi.fn(async () => committed.promise)
    const acquiring = adapter.acquire({ ...INPUT, onSpawned, options: { model: 'gpt-saved' } })
    await vi.waitFor(() => expect(onSpawned).toHaveBeenCalledOnce())
    expect(codex.connections[0].calls).toEqual([])
    committed.resolve()
    const acquired = await acquiring
    expect(acquired.process.pid).toBe(4321)
    expect(acquired.link).toBeUndefined()
    expect(codex.connections[0].calls).toEqual([])
    const opening = open(adapter, acquired.acquisitionGeneration)
    await vi.waitFor(() => expect(codex.connections[0].calls[0]?.method).toBe('initialize'))
    expect(events).toEqual([])
    initialized.resolve({})
    await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe('thread/start'))
    expect(events).toEqual([])
    threaded.resolve({ thread: { id: THREAD_ID }, model: 'gpt-live' })
    expect(await opening).toMatchObject({
      link: { handle: { nativeId: THREAD_ID } },
      reportedOptions: { model: 'gpt-saved' },
      restoreSkippedOptions: [],
      optionRevision: 0
    })
    expect(events.some((event) => event.type === 'started')).toBe(false)
    await adapter.closeAll()
  })

  it.each(['initialize', 'thread/start'])(
    'rejects a failed %s without closing or settling it inside the adapter',
    async (method) => {
      const gate = Promise.withResolvers<unknown>()
      const { adapter, codex, events } = startup({ [method]: () => gate.promise })
      const acquired = await adapter.acquire(INPUT)
      const opening = open(adapter, acquired.acquisitionGeneration)
      await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe(method))
      gate.reject(new CodexAppServerRequestError(method, -32603, 'not signed in', 'not signed in'))
      await expect(opening).rejects.toThrow('not signed in')
      expect(codex.connections[0].closeCount).toBe(0)
      expect(events).toEqual([])
      expect(await adapter.closeSession('session-1')).toBe(true)
      expect(codex.connections[0].closeCount).toBe(1)
      expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    }
  )

  it.each(['initialize', 'thread/start'])(
    'aborts a held %s on Stop with one close and no later ready result',
    async (method) => {
      const gate = Promise.withResolvers<unknown>()
      const { adapter, codex } = startup({ [method]: () => gate.promise })
      const acquired = await adapter.acquire(INPUT)
      const controller = new AbortController()
      const opening = open(adapter, acquired.acquisitionGeneration, controller.signal)
      await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe(method))
      controller.abort(new Error('stopped'))
      await expect(opening).rejects.toThrow('stopped')
      expect(await adapter.closeSession('session-1')).toBe(true)
      gate.resolve(method === 'thread/start' ? { thread: { id: THREAD_ID } } : {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(codex.connections[0].closeCount).toBe(1)
      expect(codex.connections[0].calls.some((call) => call.method === 'turn/start')).toBe(false)
    }
  )

  it('returns a resumed link only after thread/resume answers', async () => {
    const gate = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'thread/resume': () => gate.promise })
    const adapter = adapterFor(codex, { resumeThreadId: THREAD_ID })
    const acquired = await adapter.acquire(INPUT)
    const opening = open(adapter, acquired.acquisitionGeneration)
    await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe('thread/resume'))
    gate.resolve({ thread: { id: THREAD_ID } })
    expect(await opening).toMatchObject({ link: { origin: 'resumed' } })
    await adapter.closeAll()
  })

  it('does not start a fallback thread after Stop during a held resume', async () => {
    const gate = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'thread/resume': () => gate.promise })
    const adapter = adapterFor(codex, {
      resumeThreadId: THREAD_ID,
      supersedeIfUnsaved: true
    })
    const acquired = await adapter.acquire(INPUT)
    const controller = new AbortController()
    const opening = open(adapter, acquired.acquisitionGeneration, controller.signal)
    await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe('thread/resume'))
    controller.abort(new Error('stopped'))
    await expect(opening).rejects.toThrow('stopped')
    gate.reject(
      new CodexAppServerRequestError(
        'thread/resume',
        -32600,
        `no rollout found for thread id ${THREAD_ID}`
      )
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(codex.connections[0].calls.some((call) => call.method === 'thread/start')).toBe(false)
    expect(await adapter.closeSession('session-1')).toBe(true)
  })

  it('rejects oversized history without importing part of it', async () => {
    const { adapter, codex } = startup({
      'thread/start': () => ({
        thread: {
          id: THREAD_ID,
          turns: [
            {
              id: 'old-turn',
              items: Array.from({ length: 1_025 }, (_, i) => ({
                type: 'agentMessage',
                id: `old-${i}`,
                text: 'old message'
              }))
            }
          ]
        }
      })
    })
    const sink: StructuredAgentSessionEventSink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
    const acquired = await adapter.acquire({ ...INPUT, events: sink })
    await expect(open(adapter, acquired.acquisitionGeneration)).rejects.toMatchObject({
      name: AgentSessionAcquisitionRefusal.name,
      reason: 'historyTooLarge'
    })
    expect(sink.appendItem).not.toHaveBeenCalled()
    expect(codex.connections[0].closeCount).toBe(0)
    expect(await adapter.closeSession('session-1')).toBe(true)
    expect(codex.connections[0].closeCount).toBe(1)
  })

  it('retains natural exit evidence during thread open', async () => {
    const gate = Promise.withResolvers<unknown>()
    const { adapter, codex, events } = startup({ 'thread/start': () => gate.promise })
    const acquired = await adapter.acquire(INPUT)
    const opening = open(adapter, acquired.acquisitionGeneration)
    await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe('thread/start'))
    codex.connections[0].closed = true
    codex.connections[0].handlers.onExit?.(new Error('child exited'))
    gate.resolve({ thread: { id: THREAD_ID } })
    await expect(opening).rejects.toThrow()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        cause: 'unexpected-exit'
      })
    )
    expect(codex.connections[0].closeCount).toBe(0)
  })
})
