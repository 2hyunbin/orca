import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { mainProcessState } from '../../startup/main-process-state'
import { startDesktopPushService } from '../../startup/main-process-push-startup'
import { expect, it, vi } from 'vitest'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from '../../runtime/runtime-mobile-notification-controller'
import { flush } from '../../runtime/push/push-dispatcher.test-fixture'
import { NOTIFICATIONS_HOST_AGENT_ALERTS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  call: vi.fn(),
  subscribe: vi.fn(),
  status: vi.fn(),
  retired: vi.fn(),
  generation: 1,
  runtime: {},
  runtimeRpc: {}
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { app: Object.assign(new EventEmitter(), { getPath: () => '/user-data' }) }
})
vi.mock('../../startup/main-process-state', () => ({ mainProcessState: mocks }))
vi.mock('../../orca-profiles/profile-cloud-auth-config', () => ({
  getOrcaPushGatewayUrl: () => ''
}))
vi.mock('../../runtime/push/desktop-push-service', () => ({
  DesktopPushService: { create: () => null }
}))
vi.mock('./runtime-environment-mobile-relay-hosts', () => ({
  createRuntimeEnvironmentMobileRelayHosts: () => ({
    list: mocks.list,
    call: mocks.call,
    onStatusChanged: mocks.status,
    onEnvironmentRetired: mocks.retired
  })
}))
vi.mock('./runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: mocks.subscribe
}))
vi.mock('./runtime-environment-transport-generation', () => ({
  getRuntimeEnvironmentTransportGeneration: () => mocks.generation
}))

it('recovers admission and catch-up in scope, survives vetoed quit and reconciles restart dismissal', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const path = mkdtempSync(join(tmpdir(), 'orca-30900-source-feed-'))
  const source = new RuntimeMobileNotificationController()
  source.configureDismissalStore(join(path, 'source'))
  let carrier = new RuntimeMobileNotificationController()
  carrier.configureDismissalStore(join(path, 'carrier'))
  const events: MobileNotificationEvent[] = []
  let callbacks: Parameters<typeof subscribeRuntimeEnvironment>[5] | undefined
  let statusChanged = () => {}
  let supported = false
  let reachable = true
  let pairingRevision = 7
  let retired = (_id: string) => {}
  mocks.list.mockImplementation(() => ({
    environments: [{ id: 'server', pairingRevision }],
    statusByEnvironmentId: new Map([
      [
        'server',
        {
          status: reachable
            ? {
                runtimeId: 'b',
                capabilities: supported ? [NOTIFICATIONS_HOST_AGENT_ALERTS_RUNTIME_CAPABILITY] : []
              }
            : undefined
        }
      ]
    ])
  }))
  mocks.status.mockImplementation((listener) => {
    statusChanged = listener
    return () => {}
  })
  mocks.retired.mockImplementation((listener) => {
    retired = listener
    return () => {}
  })
  mocks.subscribe.mockRejectedValueOnce(new Error('remote_runtime_busy'))
  mocks.subscribe.mockImplementation(
    async (...args: Parameters<typeof subscribeRuntimeEnvironment>) => {
      callbacks = args[5]
      return { close: () => {} }
    }
  )
  mocks.call.mockImplementation(async (_host, _method, params) => {
    return {
      ok: true,
      _meta: { runtimeId: 'b' },
      result: {
        notifications: source.getMissedSince(params.lastSeenSeq, params.epoch, true),
        dismissedPushes: source.reconcileDismissedPushes(params.deliveredPushes)
      }
    }
  })
  const connect = () => {
    carrier.onDispatched((event) => events.push(event))
    mocks.runtime = {
      setNotificationSourceHost: carrier.setSourceHost.bind(carrier),
      carrySourceAgentAlert: carrier.carrySourceAlert.bind(carrier),
      getCarriedSourceDeliveries: carrier.carriedSourceDeliveries.bind(carrier)
    }
    startDesktopPushService(mainProcessState.runtimeRpc!)
    return () => app.emit('will-quit')
  }
  const frame = (result: unknown, runtimeId = 'b') =>
    callbacks?.onEvent({
      type: 'response',
      response: { id: 'source', ok: true, _meta: { runtimeId }, result }
    })
  const retry = async () => {
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
  }
  let stop = connect()
  try {
    expect(mocks.subscribe).not.toHaveBeenCalled()
    supported = true
    statusChanged()
    await flush()
    expect(vi.getTimerCount()).toBe(1)
    reachable = false
    await retry()
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    expect(carrier.sourceHosts.has('runtime:server')).toBe(true)
    reachable = true
    await retry()
    expect(mocks.subscribe).toHaveBeenCalledTimes(2)
    source.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Needs input',
      body: '',
      worktreeId: 'folder',
      notificationId: 'waiting-1',
      sourcePlan: { kind: 'terminal', direct: [] }
    })
    const news = source.getMissedSince(0)[0]
    frame(news, 'another-runtime')
    await flush()
    expect(events).toHaveLength(0)
    mocks.call.mockRejectedValueOnce(new Error('unreachable'))
    frame({ type: 'ready', epoch: source.getEpoch() })
    await flush()
    expect(events).toHaveLength(0)
    await retry()
    frame({ type: 'ready', epoch: source.getEpoch() })
    await flush()
    expect(events).toHaveLength(1)
    const carried = events[0]!
    expect(carried).toMatchObject({
      executionHost: 'runtime:server',
      notificationEpoch: carrier.getEpoch()
    })
    frame(news)
    await flush()
    expect(events).toHaveLength(1)
    app.emit('before-quit', { defaultPrevented: true })
    callbacks?.onClose()
    await retry()
    frame({ type: 'ready', epoch: source.getEpoch() })
    await flush()
    expect(mocks.call.mock.lastCall?.[2].lastSeenSeq).toBe(news?.notificationSeq)
    expect(events).toHaveLength(1)
    const staleCallbacks = callbacks
    callbacks?.onClose()
    pairingRevision += 1
    mocks.generation += 1
    await retry()
    stop()
    await carrier.closeDismissals()
    source.dismiss('waiting-1')
    carrier = new RuntimeMobileNotificationController()
    carrier.configureDismissalStore(join(path, 'carrier'))
    stop = connect()
    await flush()
    staleCallbacks?.onEvent({
      type: 'response',
      response: { id: 'stale', ok: true, _meta: { runtimeId: 'b' }, result: news }
    })
    frame({ type: 'ready', epoch: source.getEpoch() })
    await flush()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'dismiss',
      notificationId: carried.notificationId,
      dismissedDelivery: {
        notificationEpoch: carried.notificationEpoch,
        notificationSeq: carried.notificationSeq
      }
    })
    expect(carrier.carriedSourceDeliveries('runtime:server')).toEqual([])
    callbacks?.onClose()
    retired('server')
    const attempts = mocks.subscribe.mock.calls.length
    await retry()
    expect(mocks.subscribe).toHaveBeenCalledTimes(attempts)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    stop()
    await source.closeDismissals()
    await carrier.closeDismissals()
    vi.useRealTimers()
    rmSync(path, { recursive: true, force: true })
  }
})
