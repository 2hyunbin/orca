import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hooks/server'
import { AgentTransitionDetector } from '../../agent-hooks/agent-transition-detector'
import { buildAgentNotificationId } from '../../../shared/agent-notification-id'
import {
  getAgentCompletionIdentityStoreSizeForTest,
  resetAgentCompletionIdentityStoreForTest
} from '../../../shared/agent-completion-identity-store'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationDispatchEvent
} from '../runtime-mobile-notification-controller'
import { createTerminalAgentMobileAttention } from '../terminal-agent-mobile-attention'
import { SourceAgentAlertEvent } from '../source-agent-alert-event'
import { planSourceAgentRecipients } from './push-dispatcher'
import { createHarness, flush, registration } from './push-dispatcher.test-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const WT = 'repo-1::/tmp/a'
const PANE = 'tab-a:22222222-2222-4222-8222-222222222222'
const DIGEST = 'a'.repeat(64)

function createExecutionHost(
  controller?: RuntimeMobileNotificationController,
  seedWorking = false
) {
  vi.setSystemTime(10_000)
  const server = new AgentHookServer()
  const detector = new AgentTransitionDetector({
    resolveTabWorktreeId: () => undefined,
    now: Date.now
  })
  const announced: MobileNotificationDispatchEvent[] = []
  const producer = createTerminalAgentMobileAttention({
    readRow: (paneKey) => detector.latestRow(paneKey),
    readNotificationSettings: getDefaultNotificationSettings,
    readWorkspaceLabels: () => ({ repoLabel: 'repo', worktreeLabel: 'feat/x' }),
    isWorkspaceMuted: () => false,
    dispatch: (event) => {
      announced.push(event)
      controller?.dispatch(event)
    },
    retire: (worktreeId, paneKey, before) =>
      controller?.retireTerminalAttention(worktreeId, paneKey, before),
    now: Date.now
  })
  const unsubscribe = detector.subscribe(producer.observe)
  let clock = 10_000
  const hook = (
    row: Partial<ParsedAgentStatusPayload> & Pick<ParsedAgentStatusPayload, 'state'>,
    newTurn: boolean | 'replay' = false
  ) => {
    clock += 1_000
    vi.setSystemTime(clock)
    const event = {
      paneKey: PANE,
      tabId: 'tab-a',
      worktreeId: WT,
      payload: { prompt: 'ship it', agentType: 'claude' as const, ...row }
    }
    if (newTurn) {
      server.ingestRemote(
        {
          ...event,
          source: 'claude',
          hookEventName: row.state === 'working' ? 'UserPromptSubmit' : 'Stop',
          ...(newTurn === 'replay' ? { isReplay: true } : {})
        },
        null
      )
    } else {
      server.ingestTerminalStatus(event)
    }
  }
  if (seedWorking) {
    hook({ state: 'working' })
  }
  const detach = detector.attach(server)
  return {
    announced,
    detector,
    stop: () => {
      detach()
      unsubscribe()
      producer.dispose()
    },
    hook,
    settle() {
      vi.advanceTimersByTime(1500)
    }
  }
}

const idAt = (stateStartedAt: number) =>
  buildAgentNotificationId({ worktreeId: WT, paneKey: PANE, stateStartedAt })

it('keeps historical/non-agent rows silent and delivers, retires and disposes seeded/replayed turns', async () => {
  resetAgentCompletionIdentityStoreForTest()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-host-announced-alerts-'))
  const source = new RuntimeMobileNotificationController()
  const carrier = new RuntimeMobileNotificationController()
  source.configureDismissalStore(join(userDataPath, 'source'))
  carrier.configureDismissalStore(join(userDataPath, 'carrier'))
  const direct = registration({
    registrationId: 'direct',
    destinationDigest: DIGEST,
    filter: { hostAgentAlerts: true, sourceAgentAlerts: true }
  })
  const onlyA = registration({
    registrationId: 'only-a',
    destinationDigest: 'b'.repeat(64),
    filter: { sourceAgentAlerts: true, hostAgentAlerts: false }
  })
  const devices = [
    { deviceId: 'phone', pushRegistration: direct },
    { deviceId: 'old', pushRegistration: registration({ registrationId: 'older' }) }
  ]
  const b = createHarness({ devices })
  const a = createHarness({
    devices: [
      { deviceId: 'both', pushRegistration: { ...direct, registrationId: 'both-a' } },
      { deviceId: 'only-a', pushRegistration: onlyA }
    ]
  })
  source.setPushRegistrar({
    planAgentAlert: () =>
      planSourceAgentRecipients(
        { listDevices: () => devices, setPushRegistration: () => true },
        true
      ),
    register: async () => ({ registered: false, reason: 'throttled' }),
    unregister: async () => ({ unregistered: false }),
    test: async () => ({ accepted: false, reason: 'unavailable' })
  })
  source.onDispatched((event) => {
    b.dispatcher.enqueue(event)
    const parsed = SourceAgentAlertEvent.safeParse(event)
    if (parsed.success) {
      carrier.carrySourceAlert('runtime:server', parsed.data)
    }
  })
  carrier.onDispatched((event) => a.dispatcher.enqueue(event))
  carrier.setSourceHost('runtime:server', true)
  let host = createExecutionHost()
  try {
    host.hook({ state: 'done' }, 'replay')
    expect(host.detector.latestRow(PANE)?.isReplay).toBe(true)
    host.settle()
    expect(host.announced).toEqual([])
    host.hook({ state: 'working' })
    host.hook({ state: 'done' })
    host.hook({ state: 'working', agentType: 'make' })
    host.hook({ state: 'done', agentType: 'make' })
    host.settle()
    expect(host.announced).toEqual([])
    host.stop()
    host = createExecutionHost(source, true)
    const at = Date.now() + 500
    host.hook({ state: 'working', turnCompletedAt: at })
    host.hook({ state: 'done' })
    host.settle()
    expect(host.announced.map((event) => event.notificationId)).toEqual([idAt(at)])
    await flush()
    b.dispatcher.enqueue({
      ...host.announced[0]!,
      hostAgentAlert: false,
      executionHostAnnounces: true,
      notificationSeq: 10,
      notificationEpoch: source.getEpoch()
    })
    await flush()
    expect(b.sends.map((send) => send.registrationIds)).toEqual([['direct'], ['older']])
    expect(a.sends.map((send) => send.registrationIds)).toEqual([['only-a']])
    carrier.dispatch({
      ...host.announced[0]!,
      hostAgentAlert: false,
      executionHost: 'runtime:server',
      executionHostAnnounces: true,
      agentState: 'waiting'
    })
    await flush()
    expect(a.sends).toHaveLength(1)
    host.hook({ state: 'working' }, 'replay')
    await flush()
    expect(b.sends.at(-1)?.notification).toMatchObject({
      kind: 'dismiss',
      notificationId: idAt(at),
      notificationSeq: 1
    })
    expect(a.sends.at(-1)?.notification).toMatchObject({
      kind: 'dismiss',
      notificationEpoch: carrier.getEpoch(),
      notificationSeq: 1
    })
    expect(a.sends.at(-1)?.notification.notificationId).not.toBe(idAt(at))
    const completedAt = Date.now() + 500
    host.hook({ state: 'working', turnCompletedAt: completedAt })
    host.hook({
      state: 'working',
      turnCompletedAt: completedAt,
      lastAssistantMessage: 'Background work'
    })
    expect(host.announced.map((event) => event.notificationId)).toEqual([
      idAt(at),
      idAt(completedAt)
    ])
    expect(source.getMissedSince(0).filter((event) => event.type === 'dismiss')).toHaveLength(1)
    host.hook({ state: 'done' })
    host.settle()
    expect(host.announced).toHaveLength(2)
    host.hook({ state: 'working' }, true)
    expect(source.getMissedSince(0).at(-1)).toMatchObject({
      type: 'dismiss',
      notificationId: idAt(completedAt)
    })
    host.hook({ state: 'done' })
    host.stop()
    host.settle()
    expect(host.announced).toHaveLength(2)
    expect(getAgentCompletionIdentityStoreSizeForTest()).toBe(0)
  } finally {
    host.stop()
    await source.closeDismissals()
    await carrier.closeDismissals()
    vi.useRealTimers()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
