import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { subscribeRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import {
  registerRuntimeEnvironmentSubscriptionHandlers,
  type PendingRuntimeSubscription,
  type RetainedRemoteRuntimeSubscription
} from '../ipc/runtime-environments/runtime-environment-subscription-handlers'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { authenticatedDesktopSockets } from './rpc/mobile-socket-wiring.test-fixture'
import { phoneRelayFlow } from './structured-phone-relay.test-fixture'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn(), subscribe: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, on: mocks.on } }))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'env', pairingRevision: 1, createdAt: 1 })
}))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: mocks.subscribe
}))

it('navigation retires the actual scoped stream while a separate control transport stays open and another source survives', async () => {
  const f = await phoneRelayFlow()
  const second = await f.attachOtherSource()
  const remote = new Map<string, RetainedRemoteRuntimeSubscription>()
  const pending = new Map<string, PendingRuntimeSubscription>()
  const control = await authenticatedDesktopSockets(CALLER.callerKey, 1, 2)
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    send: vi.fn()
  })
  const otherWindow = Object.assign(new EventEmitter(), {
    id: 2,
    isDestroyed: () => false,
    send: vi.fn()
  })
  mocks.handle.mockClear()
  registerRuntimeEnvironmentSubscriptionHandlers({
    getUserDataPath: () => '/test',
    remoteRuntimeSubscriptions: remote,
    pendingSubscriptions: pending,
    recordLayoutFrame: vi.fn()
  })
  mocks.subscribe.mockImplementation(
    async (...args: Parameters<typeof subscribeRuntimeEnvironment>) => {
      const stream = await f.stream(args[3], undefined, false, (response) => {
        args[5].onEvent({ type: 'response', response })
      })
      args[7]?.addEventListener('abort', stream.close, { once: true })
      return { requestId: 'registered-rpc', sendBinary: () => false, close: stream.close }
    }
  )
  const subscribe = mocks.handle.mock.calls.find(
    ([name]) => name === 'runtimeEnvironments:subscribe'
  )![1]
  const unsubscribe = mocks.handle.mock.calls.find(
    ([name]) => name === 'runtimeEnvironments:unsubscribe'
  )![1]
  try {
    await subscribe(
      { sender },
      {
        selector: 'env',
        method: 'agentSession.subscribeTurnCompletions',
        subscriptionId: 'source-1',
        params: { includePrompts: true, phoneRelaySessionId: SESSION }
      }
    )
    await subscribe(
      { sender: otherWindow },
      {
        selector: 'env',
        method: 'agentSession.subscribeTurnCompletions',
        subscriptionId: 'source-2',
        params: { includePrompts: true, phoneRelaySessionId: second }
      }
    )
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(true)
    expect(f.h.host.hasPhoneRelay(second, CALLER.callerKey)).toBe(true)
    const first = await f.send('Accepted before reload')
    await f.turn('reload', first, 'running')
    sender.emit('did-navigate', {}, 'file:///app', 200, 'OK')
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(false)
    expect(f.h.host.hasPhoneRelay(second, CALLER.callerKey)).toBe(true)
    expect(remote.size).toBe(1)
    expect(pending.size).toBe(0)
    expect(control.wiring.connectionCount).toBe(1)
    await f.turn('reload', first, 'completed')
    expect(f.sent.filter((event) => event.type === 'notification')).toHaveLength(1)
    expect(otherWindow.send).not.toHaveBeenCalled()
    await subscribe(
      { sender },
      {
        selector: 'env',
        method: 'agentSession.subscribeTurnCompletions',
        subscriptionId: 'replacement',
        params: { includePrompts: true, phoneRelaySessionId: SESSION }
      }
    )
    const next = await f.send('New document forwards')
    await f.turn('new-document', next, 'running')
    await f.turn('new-document', next, 'completed')
    expect(f.sent.filter((event) => event.type === 'notification')).toHaveLength(1)
    expect(sender.send).toHaveBeenCalled()
    expect(unsubscribe({ sender }, { subscriptionId: 'source-1' })).toEqual({ unsubscribed: false })
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(true)
  } finally {
    for (const value of remote.values()) {
      value.close()
    }
    for (const value of pending.values()) {
      value.close()
    }
    control.close()
    await f.close()
  }
})

it('drops a throwing registered recipient and falls back on the next edge', async () => {
  const f = await phoneRelayFlow()
  try {
    const source = await f.stream(
      { includePrompts: true, phoneRelaySessionId: SESSION },
      undefined,
      false,
      (response) => {
        if (response.ok) {
          throw new Error('Renderer transport gone')
        }
      }
    )
    const first = await f.send('Before emit failure')
    await f.turn('emit-failure', first, 'running')
    await f.prompt(1, 'emit-failure')
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(false)
    const before = f.sent.filter((event) => event.type === 'notification').length
    await f.prompt(2, 'emit-failure')
    expect(f.sent.filter((event) => event.type === 'notification')).toHaveLength(before + 1)
    const replacement = await f.stream({ includePrompts: true, phoneRelaySessionId: SESSION })
    source.close()
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(true)
    replacement.close()
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(false)
  } finally {
    await f.close()
  }
})
