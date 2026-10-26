// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { subscribeRuntimeEnvironmentFromPreload } from '../../../preload/runtime-environment-subscriptions'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'

it('routes before activation and cancels pending setup by its exact id, then disposes the late handle', async () => {
  const events = new EventEmitter()
  const pending = Promise.withResolvers<{ subscriptionId: string; requestId: string }>()
  const requests: { channel: string; args: unknown }[] = []
  let subscriptionId = ''
  const ipc = {
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    send: vi.fn(),
    invoke: (channel: string, args: unknown): Promise<unknown> => {
      requests.push({ channel, args })
      if (channel === 'runtimeEnvironments:subscribe') {
        expect(events.listenerCount('runtimeEnvironments:subscriptionEvent')).toBe(1)
        if (
          !args ||
          typeof args !== 'object' ||
          !('subscriptionId' in args) ||
          typeof args.subscriptionId !== 'string'
        ) {
          throw new Error('Expected assigned subscription id')
        }
        subscriptionId = args.subscriptionId
        events.emit(
          'runtimeEnvironments:subscriptionEvent',
          {},
          {
            subscriptionId,
            type: 'response',
            response: {
              id: 'early',
              ok: true,
              result: 'before-setup-reply',
              _meta: { runtimeId: 'host' }
            }
          }
        )
        return pending.promise
      }
      return Promise.resolve({ unsubscribed: true })
    }
  }
  const previous = window.api
  const callbacks = { onEvent: vi.fn(), onError: vi.fn(), onClose: vi.fn() }
  const controller = new AbortController()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtimeEnvironments: {
        subscribe: (
          args: Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[1],
          handlers: Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[2]
        ) => subscribeRuntimeEnvironmentFromPreload(ipc, args, handlers),
        cancelSubscription: (args: { subscriptionId: string }) =>
          ipc.invoke('runtimeEnvironments:unsubscribe', args)
      }
    }
  })
  try {
    const opening = subscribeRuntimeRpc(
      { kind: 'environment', environmentId: 'env' },
      'agentSession.subscribeTurnCompletions',
      { includePrompts: true, phoneRelaySessionId: 'source' },
      { ...callbacks, signal: controller.signal }
    )
    const rejected = expect(opening).rejects.toThrow('setup cancelled')
    expect(callbacks.onEvent).toHaveBeenCalledWith('before-setup-reply')
    controller.abort()
    expect(requests.at(-1)).toEqual({
      channel: 'runtimeEnvironments:unsubscribe',
      args: { subscriptionId }
    })
    pending.resolve({ subscriptionId, requestId: 'remote-request' })
    await rejected
    expect(events.listenerCount('runtimeEnvironments:subscriptionEvent')).toBe(0)
    events.emit(
      'runtimeEnvironments:subscriptionEvent',
      {},
      {
        subscriptionId,
        type: 'response',
        response: { id: 'late', ok: true, result: 'stale', _meta: { runtimeId: 'host' } }
      }
    )
    expect(callbacks.onEvent).toHaveBeenCalledTimes(1)
    expect(
      requests.filter((request) => request.channel === 'runtimeEnvironments:unsubscribe')
    ).toHaveLength(2)
  } finally {
    Object.defineProperty(window, 'api', { configurable: true, value: previous })
  }
})
