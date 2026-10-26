import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  eraseRpcMethods,
  isStreamingMethod,
  type RpcContext,
  type RpcStreamingMethod
} from '../core'
// Import the registry to avoid client-events' module-init cycle through ipc/ssh.
import { ALL_RPC_METHODS } from './index'

const subscribeMethod = eraseRpcMethods(ALL_RPC_METHODS).find(
  (method) => method.name === 'runtime.clientEvents.subscribe' && isStreamingMethod(method)
) as RpcStreamingMethod

function makeRuntime(): {
  runtime: OrcaRuntimeService
  onClientEvent: ReturnType<typeof vi.fn>
  cleanups: (() => void)[]
  subscribed: Promise<void>
} {
  const cleanups: (() => void)[] = []
  const { promise: subscribed, resolve: markSubscribed } = Promise.withResolvers<void>()
  const onClientEvent = vi.fn(
    (
      _listener: (event: RuntimeClientEvent) => void,
      _options?: { consumesTerminalSideEffects?: boolean }
    ) =>
      () => {}
  )
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'onClientEvent').mockImplementation(onClientEvent)
  vi.spyOn(runtime, 'registerSubscriptionCleanup').mockImplementation((_id, cleanup) => {
    cleanups.push(cleanup)
    markSubscribed()
  })
  return { runtime, onClientEvent, cleanups, subscribed }
}

describe('runtime.clientEvents.subscribe', () => {
  it('registers mobile subscriptions as non-consumers of terminal side effects', async () => {
    const { runtime, onClientEvent, cleanups, subscribed } = makeRuntime()

    const done = subscribeMethod.handler(
      undefined,
      { runtime, connectionId: 'conn-1', clientKind: 'mobile' } as RpcContext,
      () => {}
    )

    await subscribed
    expect(onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: false
    })
    cleanups.forEach((cleanup) => cleanup())
    await done
  })

  it('keeps non-mobile subscriptions consuming terminal side effects', async () => {
    const { runtime, onClientEvent, cleanups, subscribed } = makeRuntime()

    const done = subscribeMethod.handler(
      undefined,
      { runtime, connectionId: 'conn-1' } as RpcContext,
      () => {}
    )

    await subscribed
    expect(onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: true
    })
    cleanups.forEach((cleanup) => cleanup())
    await done
  })
})
