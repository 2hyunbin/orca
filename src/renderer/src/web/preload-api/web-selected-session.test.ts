import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as RuntimeRpcQueue from '../../../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { AI_VAULT_SELECTED_SESSION_CAPABILITY } from '../../../../shared/ai-vault-selected-session'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from '../web-preload-api-test-harness'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const args = {
  source: { kind: 'chat', sessionId: 'chat-1', workspaceId: 'workspace-1' },
  executionHostId: 'runtime:env-a',
  requestToken: 'selected-1'
} as const
function response(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'response', ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}
const call =
  vi.fn<
    (
      method: string,
      params?: unknown,
      options?: { signal?: AbortSignal }
    ) => Promise<RuntimeRpcResponse<unknown>>
  >()
beforeEach(async () => {
  vi.resetModules()
  call.mockReset()
  vi.doMock('../web-runtime-client', () => ({
    WebRuntimeClient: class {
      call = call
      close() {}
    }
  }))
  vi.doMock('../../../../shared/runtime-rpc-call-queue', async (original) => {
    const actual = await original<typeof RuntimeRpcQueue>()
    return {
      ...actual,
      RuntimeRpcCallQueuePool: class extends actual.RuntimeRpcCallQueuePool {
        constructor() {
          super(1)
        }
      }
    }
  })
  const { storage } = installBrowserGlobals()
  writeStoredRuntimeEnvironment(storage, 'env-a')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('../web-runtime-client')
  vi.doUnmock('../../../../shared/runtime-rpc-call-queue')
  vi.unstubAllGlobals()
})

it.each(['status.get', 'aiVault.resolveSession', 'aiVault.listSessions'])(
  'abandonment removes queued %s before it can reach the peer',
  async (target) => {
    const { runtimeCallQueuePool: pool } = await import('./web-runtime-session')
    const { resolveWebSelectedSession, cancelWebSelectedSession } =
      await import('./web-selected-session')
    const held = deferred<void>()
    const queued = deferred<void>()
    let blocking: Promise<void> | undefined
    const enqueue = pool.enqueue.bind(pool)
    vi.spyOn(pool, 'enqueue').mockImplementation(
      <T>(
        selector: string,
        method: string,
        run: () => Promise<T>,
        bytes = 0,
        signal?: AbortSignal
      ) => {
        const pending = enqueue(selector, method, run, bytes, signal)
        if (method === target) {
          queued.resolve()
        }
        return pending
      }
    )
    const holdSlot = () => {
      blocking = pool.enqueue('env-a', 'hold', () => held.promise)
    }
    if (target === 'status.get') {
      holdSlot()
    }
    call.mockImplementation(async (method, _params, options) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      if (method !== 'status.get') {
        throw new Error('Abandoned request dispatched')
      }
      holdSlot()
      return response({
        capabilities:
          target === 'aiVault.listSessions' ? [] : [AI_VAULT_SELECTED_SESSION_CAPABILITY]
      })
    })
    const selected = resolveWebSelectedSession(args)
    const rejection = expect(selected).rejects.toThrow()
    await queued.promise
    await cancelWebSelectedSession({ requestToken: args.requestToken })
    await rejection
    held.resolve()
    await blocking
    expect(call.mock.calls.map(([method]) => method)).toEqual(
      target === 'status.get' ? [] : ['status.get']
    )
  }
)

it.each(['different-id', 'same-id-before-dispatch', 'same-id-before-answer'])(
  'refuses a pairing change at %s without accepting or rerouting the operation',
  async (change) => {
    const session = await import('./web-runtime-session')
    const { resolveWebSelectedSession } = await import('./web-selected-session')
    const status = deferred<RuntimeRpcResponse<unknown>>()
    const selected = deferred<RuntimeRpcResponse<unknown>>()
    const statusStarted = deferred<void>()
    const selectedStarted = deferred<void>()
    call.mockImplementation((method) => {
      if (method === 'status.get') {
        statusStarted.resolve()
        return status.promise
      }
      selectedStarted.resolve()
      return selected.promise
    })
    const pending = resolveWebSelectedSession(args)
    const rejection = expect(pending).rejects.toThrow()
    await statusStarted.promise
    if (change === 'same-id-before-answer') {
      status.resolve(response({ capabilities: [AI_VAULT_SELECTED_SESSION_CAPABILITY] }))
      await selectedStarted.promise
    }
    session.webRuntimeState.activeEnvironment = {
      ...session.requireActiveEnvironment(),
      ...(change === 'different-id' ? { id: 'env-b' } : {}),
      pairingRevision: 2
    }
    if (change === 'same-id-before-answer') {
      selected.resolve(response({ status: 'missing' }))
    } else {
      status.resolve(response({ capabilities: [AI_VAULT_SELECTED_SESSION_CAPABILITY] }))
    }
    await rejection
    expect(call.mock.calls.map(([method]) => method)).toEqual(
      change === 'same-id-before-answer' ? ['status.get', 'aiVault.resolveSession'] : ['status.get']
    )
  }
)
