import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hooks/server'
import { AgentTransitionDetector } from '../../agent-hooks/agent-transition-detector'
import { buildAgentNotificationId } from '../../../shared/agent-notification-id'
import { resetAgentCompletionIdentityStoreForTest } from '../../../shared/agent-completion-identity-store'
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
const SETTINGS = {
  enabled: true,
  agentTaskComplete: true,
  terminalBell: true,
  suppressWhenFocused: false,
  customSoundId: 'system',
  customSoundPath: null,
  customSoundVolume: 1,
  mutedNotificationSourceIds: [],
  notifyHiddenWorkspaces: true
} as const

function createExecutionHost(controller?: RuntimeMobileNotificationController) {
  const server = new AgentHookServer()
  const detector = new AgentTransitionDetector({
    resolveTabWorktreeId: () => undefined,
    now: Date.now
  })
  const announced: MobileNotificationDispatchEvent[] = []
  detector.subscribe(
    createTerminalAgentMobileAttention({
      readRow: (paneKey) => detector.latestRow(paneKey),
      readNotificationSettings: () => ({ ...SETTINGS, mutedNotificationSourceIds: [] }),
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
  )
  detector.attach(server)
  let clock = 10_000
  return {
    announced,
    server,
    detector,
    hook(
      row: Partial<ParsedAgentStatusPayload> & Pick<ParsedAgentStatusPayload, 'state'>,
      newTurn = false
    ) {
      clock += 1_000
      vi.setSystemTime(clock)
      const event = {
        paneKey: PANE,
        tabId: 'tab-a',
        worktreeId: WT,
        payload: { prompt: 'ship it', agentType: 'claude' as const, ...row }
      }
      if (newTurn) {
        server.ingestRemote({ ...event, source: 'claude', hookEventName: 'UserPromptSubmit' }, null)
      } else {
        server.ingestTerminalStatus(event)
      }
      return detector.latestRow(PANE)!.stateStartedAt
    },
    settle() {
      vi.advanceTimersByTime(1500)
    }
  }
}

const idAt = (stateStartedAt: number) =>
  buildAgentNotificationId({ worktreeId: WT, paneKey: PANE, stateStartedAt })

describe('host-announced agent alerts', () => {
  let userDataPath: string
  beforeEach(() => {
    resetAgentCompletionIdentityStoreForTest()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-host-announced-alerts-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('the host announces each hook turn once, under the id its window uses', () => {
    const host = createExecutionHost()

    host.hook({ state: 'working' })
    const finishedAt = host.hook({ state: 'done' })
    expect(host.announced).toEqual([])
    host.settle()
    expect(host.announced).toEqual([
      expect.objectContaining({
        source: 'agent-task-complete',
        agentState: 'done',
        worktreeId: WT,
        notificationId: idAt(finishedAt)
      })
    ])

    // A turn that resumes inside the quiet window was not finished.
    host.hook({ state: 'working' })
    host.hook({ state: 'done' })
    host.hook({ state: 'working' })
    host.settle()
    expect(host.announced).toHaveLength(1)

    const askedAt = host.hook({ state: 'waiting' })
    expect(host.announced.at(-1)).toMatchObject({
      agentState: 'waiting',
      notificationId: idAt(askedAt)
    })

    // The lead turn ends while background work keeps the pane working; its later all-clear is old news.
    host.hook({ state: 'working' })
    const turnEndedAt = Date.now() + 500
    host.hook({ state: 'working', turnCompletedAt: turnEndedAt })
    expect(host.announced.at(-1)).toMatchObject({
      agentState: 'done',
      notificationId: idAt(turnEndedAt)
    })
    host.hook({ state: 'done', turnCompletedAt: turnEndedAt })
    host.settle()
    expect(host.announced).toHaveLength(3)
  })

  it("the host's own phones get one copy each: main's for updated phones, the window's for older ones", async () => {
    const host = createExecutionHost()
    const push = createHarness({
      devices: [
        {
          deviceId: 'updated-phone',
          pushRegistration: registration({
            registrationId: 'reg-updated',
            destinationDigest: DIGEST,
            filter: { hostAgentAlerts: true, sourceAgentAlerts: true }
          })
        },
        { deviceId: 'older-phone', pushRegistration: registration({ registrationId: 'reg-older' }) }
      ]
    })
    let seq = 0
    const deliver = (event: MobileNotificationDispatchEvent) =>
      push.dispatcher.enqueue({ ...event, notificationSeq: ++seq, notificationEpoch: 'epoch' })

    host.hook({ state: 'working' })
    host.hook({ state: 'done' })
    host.settle()
    deliver({ ...host.announced[0]!, sourcePlan: { kind: 'terminal', direct: [DIGEST] } })
    deliver({ ...host.announced[0]!, hostAgentAlert: false, executionHostAnnounces: true })
    await flush()
    expect(push.sends.map((send) => send.registrationIds)).toEqual([['reg-updated'], ['reg-older']])
  })

  it('keeps unknown replay and non-agent programs silent through the actual hook projection', () => {
    const host = createExecutionHost()
    host.server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-a',
        worktreeId: WT,
        isReplay: true,
        source: 'claude',
        hookEventName: 'Stop',
        payload: { state: 'done', agentType: 'claude', prompt: 'old' }
      },
      null
    )
    expect(host.detector.latestRow(PANE)?.isReplay).toBe(true)
    host.settle()
    expect(host.announced).toEqual([])
    host.hook({ state: 'working' })
    host.hook({ state: 'done' })
    host.hook({ state: 'working', agentType: 'make' })
    host.hook({ state: 'done', agentType: 'make' })
    host.settle()
    expect(host.announced).toEqual([])
    host.hook({ state: 'working' })
    const completedAt = Date.now() + 500
    host.hook({ state: 'working', turnCompletedAt: completedAt })
    host.hook({ state: 'done' })
    host.settle()
    expect(host.announced.map((event) => event.notificationId)).toEqual([idAt(completedAt)])
  })

  it('uses one source recipient set for direct and carrier delivery, and retires each sender identity', async () => {
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
    const devices = [{ deviceId: 'phone', pushRegistration: direct }]
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
    const host = createExecutionHost(source)
    try {
      host.hook({ state: 'working' })
      const at = host.hook({ state: 'waiting' })
      await flush()
      expect(b.sends.map((send) => send.registrationIds)).toEqual([['direct']])
      expect(a.sends.map((send) => send.registrationIds)).toEqual([['only-a']])
      carrier.dispatch({
        type: 'notification',
        source: 'agent-task-complete',
        title: 'raw window copy',
        body: '',
        worktreeId: WT,
        executionHost: 'runtime:server',
        executionHostAnnounces: true,
        agentState: 'waiting'
      })
      await flush()
      expect(a.sends).toHaveLength(1)
      vi.setSystemTime(Date.now() + 1000)
      host.server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-a',
          worktreeId: WT,
          source: 'claude',
          isReplay: true,
          payload: { state: 'working', prompt: 'next', agentType: 'claude' }
        },
        null
      )
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
      expect(source.getMissedSince(0).filter((event) => event.type === 'dismiss')).toHaveLength(1)
      host.hook({ state: 'working' }, true)
      expect(source.getMissedSince(0).at(-1)).toMatchObject({
        type: 'dismiss',
        notificationId: idAt(completedAt)
      })
    } finally {
      await source.closeDismissals()
      await carrier.closeDismissals()
    }
  })
})
