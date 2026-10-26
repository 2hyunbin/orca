import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from '../orca-runtime'
import { defineMethod, defineStreamingMethod, eraseRpcMethods, type RpcContext } from './core'
import { RpcDispatcher } from './dispatcher'
import { lazyRpcMethods } from './lazy-methods'

const runtime = new OrcaRuntimeService()
const context: RpcContext = { runtime }
const Params = z.object({ text: z.string().transform((text) => text.toUpperCase()) })
const unary = defineMethod({
  name: 'test.lazy',
  permission: 'desktop-control',
  params: Params,
  handler: (params) => params.text
})
const stream = defineStreamingMethod({
  name: 'test.stream',
  permission: 'workspace',
  params: Params,
  handler: async (params, _context, emit) => {
    emit(params.text)
  }
})
const declarations = [unary, stream]
const metadata = declarations
const request = (method: string = unary.name, params: unknown = { text: 'hello' }) => ({
  id: 'request',
  method,
  params,
  authToken: 'unused'
})

function dispatcher(load: () => Promise<typeof declarations>) {
  return new RpcDispatcher({ runtime, methods: lazyRpcMethods(metadata, load) })
}

describe('lazy RPC implementation groups', () => {
  it('shares one pending load across methods and transports, then reuses it', async () => {
    const ready = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const load = vi.fn(async () => {
      entered.resolve()
      await ready.promise
      return declarations
    })
    const rpc = dispatcher(load)
    const messages: string[] = []
    const first = rpc.dispatch(request())
    const second = rpc.dispatch(request())
    const streaming = rpc.dispatchStreaming(request(stream.name), (message) =>
      messages.push(message)
    )
    await entered.promise
    expect(load).toHaveBeenCalledTimes(1)
    ready.resolve()
    expect(await first).toMatchObject({ ok: true, result: 'HELLO' })
    expect(await second).toMatchObject({ ok: true, result: 'HELLO' })
    await streaming
    expect(messages.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({ ok: true, result: 'HELLO', streaming: true })
    ])
    await rpc.dispatch(request())
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('retires a canceled subscription during first load without registering after connection cleanup', async () => {
    const entered = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const cleanup = vi.fn()
    const handler = vi.fn<typeof stream.handler>(async (_params, ctx, emit) => {
      ctx.runtime.registerSubscriptionCleanup('cold-stream', cleanup, ctx.connectionId)
      emit('ready')
    })
    const owned = defineStreamingMethod({ ...stream, handler })
    const load = vi.fn(async () => {
      entered.resolve()
      await ready.promise
      return [owned]
    })
    const rpc = new RpcDispatcher({ runtime, methods: lazyRpcMethods([stream], load) })
    const controller = new AbortController()
    const messages: string[] = []
    const pending = rpc.dispatchStreaming(
      request(stream.name),
      (message) => messages.push(message),
      {
        connectionId: 'retired',
        signal: controller.signal
      }
    )
    await entered.promise
    controller.abort()
    runtime.cleanupSubscriptionsForConnection('retired')
    await pending
    expect(handler).not.toHaveBeenCalled()
    ready.resolve()
    await load.mock.results[0]?.value
    expect(handler).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(messages.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({ ok: false })
    ])
    const healthy: string[] = []
    await rpc.dispatchStreaming(request(stream.name), (message) => healthy.push(message), {
      connectionId: 'healthy'
    })
    runtime.cleanupSubscriptionsForConnection('healthy')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(healthy.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({ ok: true, result: 'ready' })
    ])
  })

  it('refuses callers, invalid schemas, unknown names and wrong transports without loading', async () => {
    const load = vi.fn(async () => declarations)
    const rpc = dispatcher(load)
    expect(
      await rpc.dispatch(request(), { callerScope: { kind: 'runtime-paired', grants: [] } })
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await rpc.dispatch(request(unary.name, {}))).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(await rpc.dispatch(request('test.missing'))).toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })
    expect(await rpc.dispatch(request(stream.name))).toMatchObject({
      ok: false,
      error: { code: 'method_not_supported' }
    })
    expect(load).not.toHaveBeenCalled()
  })

  it('preserves the original handler error and retries a failed load', async () => {
    const original = Object.assign(new Error('original refusal'), { code: 'forbidden' })
    const fail = defineMethod({
      ...unary,
      handler: () => {
        throw original
      }
    })
    const importError = new Error('temporary load failure')
    const load = vi
      .fn<() => Promise<(typeof fail)[]>>()
      .mockRejectedValueOnce(importError)
      .mockResolvedValue([fail])
    const [method] = eraseRpcMethods(lazyRpcMethods([unary], load))
    expect(method).toBeDefined()
    await expect(method!.handler({ text: 'HELLO' }, context)).rejects.toBe(importError)
    await expect(method!.handler({ text: 'HELLO' }, context)).rejects.toBe(original)
    await expect(method!.handler({ text: 'HELLO' }, context)).rejects.toBe(original)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('maps handler errors exactly as eager dispatch does', async () => {
    const failure = defineMethod({
      ...unary,
      handler: () => {
        throw Object.assign(new Error('permission revoked'), {
          code: 'forbidden',
          data: { reason: 'revoked' }
        })
      }
    })
    const eager = new RpcDispatcher({ runtime, methods: [failure] })
    const lazy = new RpcDispatcher({
      runtime,
      methods: lazyRpcMethods([failure], async () => [failure])
    })
    expect(await lazy.dispatch(request())).toEqual(await eager.dispatch(request()))
  })

  it('rejects stale metadata before executing a handler and allows a corrected load', async () => {
    const handler = vi.fn(unary.handler)
    const correct = defineMethod({ ...unary, handler })
    const wrong = defineMethod({ ...correct, permission: 'workspace' })
    const load = vi
      .fn<() => Promise<typeof declarations>>()
      .mockResolvedValueOnce([wrong, stream])
      .mockResolvedValue(declarations)
    const rpc = dispatcher(load)
    expect(await rpc.dispatch(request())).toMatchObject({
      ok: false,
      error: { message: 'rpc_method_metadata_mismatch:test.lazy' }
    })
    expect(handler).not.toHaveBeenCalled()
    expect(await rpc.dispatch(request())).toMatchObject({ ok: true, result: 'HELLO' })
    expect(load).toHaveBeenCalledTimes(2)
  })
})
