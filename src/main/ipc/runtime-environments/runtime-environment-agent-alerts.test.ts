import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  generation: 1
}))
vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))
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
import { startRuntimeEnvironmentAgentAlerts } from './runtime-environment-agent-alerts'

it('binds carried news to the verified source and recovers its dismissal after a carrier restart', async () => {
  const path = mkdtempSync(join(tmpdir(), 'orca-30900-source-feed-'))
  const source = new RuntimeMobileNotificationController()
  source.configureDismissalStore(join(path, 'source'))
  let carrier = new RuntimeMobileNotificationController()
  carrier.configureDismissalStore(join(path, 'carrier'))
  const events: MobileNotificationEvent[] = []
  const closed = vi.fn()
  let callbacks: Parameters<typeof subscribeRuntimeEnvironment>[5] | undefined
  let statusChanged = () => {}
  let supported = false
  mocks.list.mockImplementation(() => ({
    environments: [{ id: 'server', pairingRevision: 7 }],
    statusByEnvironmentId: new Map([
      [
        'server',
        {
          status: {
            runtimeId: 'b',
            capabilities: supported ? [NOTIFICATIONS_HOST_AGENT_ALERTS_RUNTIME_CAPABILITY] : []
          }
        }
      ]
    ])
  }))
  mocks.status.mockImplementation((listener) => {
    statusChanged = listener
    return () => {}
  })
  mocks.retired.mockReturnValue(() => {})
  mocks.subscribe.mockImplementation(
    async (...args: Parameters<typeof subscribeRuntimeEnvironment>) => {
      callbacks = args[5]
      return { close: closed }
    }
  )
  mocks.call.mockImplementation(async (host, method, params) => {
    expect(host).toEqual({ environmentId: 'server' })
    expect(method).toBe('notifications.getMissedSince')
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
    return startRuntimeEnvironmentAgentAlerts({
      setNotificationSourceHost: carrier.setSourceHost.bind(carrier),
      carrySourceAgentAlert: carrier.carrySourceAlert.bind(carrier),
      getCarriedSourceDeliveries: carrier.carriedSourceDeliveries.bind(carrier)
    })
  }
  const frame = (result: unknown, runtimeId = 'b') =>
    callbacks?.onEvent({
      type: 'response',
      response: { id: 'source', ok: true, _meta: { runtimeId }, result }
    })
  let stop = connect()
  try {
    expect(mocks.subscribe).not.toHaveBeenCalled()
    supported = true
    statusChanged()
    await flush()
    expect(mocks.subscribe.mock.calls[0]?.slice(1, 4)).toEqual([
      'server',
      'notifications.subscribe',
      { sourceEvents: true }
    ])
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
    const staleCallbacks = callbacks
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
    expect(closed).toHaveBeenCalledTimes(1)
  } finally {
    stop()
    await source.closeDismissals()
    await carrier.closeDismissals()
    rmSync(path, { recursive: true, force: true })
  }
})
