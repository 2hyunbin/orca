import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hooks/server'
import { AgentTransitionDetector } from '../../agent-hooks/agent-transition-detector'
import { createNotificationDeliveryService } from '../../notifications/notification-delivery-service'
import { buildAgentNotificationId } from '../../../shared/agent-notification-id'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import { encodePairingOffer } from '../../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../../shared/runtime-environment-store'
import { deriveRelayHostId } from '../mobile-cloud-relay/relay-http-client'
import type { MobileNotificationDispatchEvent } from '../runtime-mobile-notification-controller'
import { createTerminalAgentMobileAttention } from '../terminal-agent-mobile-attention'
import { resolveExecutionHostPushFingerprints } from './execution-host-push-fingerprints'
import { createHarness, flush, registration } from './push-dispatcher.test-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const WT = 'repo-1::/tmp/a'
const PANE = 'tab-a:22222222-2222-4222-8222-222222222222'
const SERVER_KEY = Buffer.alloc(32, 7).toString('base64')
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

/** Machine B: the hook server, the transition detector and the phone announcer, as the runtime wires them. */
function createExecutionHost() {
  const server = new AgentHookServer()
  const detector = new AgentTransitionDetector({
    resolveTabWorktreeId: () => undefined,
    now: Date.now
  })
  const announced: MobileNotificationDispatchEvent[] = []
  const holds = new Set<() => void>()
  detector.subscribe(
    createTerminalAgentMobileAttention({
      readRow: (paneKey) => detector.latestRow(paneKey),
      readNotificationSettings: () => ({ ...SETTINGS, mutedNotificationSourceIds: [] }),
      readWorkspaceLabels: () => ({ repoLabel: 'repo', worktreeLabel: 'feat/x' }),
      isWorkspaceMuted: () => false,
      dispatch: (event) => announced.push(event),
      now: Date.now,
      schedule: (run) => {
        holds.add(run)
        return () => holds.delete(run)
      }
    })
  )
  detector.attach(server)
  let clock = 10_000
  return {
    announced,
    hook(row: Partial<ParsedAgentStatusPayload> & Pick<ParsedAgentStatusPayload, 'state'>) {
      clock += 1_000
      vi.setSystemTime(clock)
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-a',
        worktreeId: WT,
        payload: { prompt: 'ship it', agentType: 'claude', ...row }
      })
      return detector.latestRow(PANE)!.stateStartedAt
    },
    /** The quiet window elapses. */
    settle() {
      for (const run of holds) {
        holds.delete(run)
        run()
      }
    }
  }
}

const idAt = (stateStartedAt: number) =>
  buildAgentNotificationId({ worktreeId: WT, paneKey: PANE, stateStartedAt })

describe('host-announced agent alerts', () => {
  let userDataPath: string
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
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

    // Needs input is news at once.
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
            filter: { hostAgentAlerts: true }
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
    deliver(host.announced[0]!)
    // The window's hook-lane copy of the same turn, from the tab it holds.
    deliver({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'feat/x - Claude finished',
      body: 'Done.',
      worktreeId: WT,
      agentState: 'done',
      executionHostAnnounces: true
    })
    await flush()
    expect(push.sends.map((send) => send.registrationIds)).toEqual([['reg-updated'], ['reg-older']])
  })

  it('a desktop forwarding that news skips only phones that hear the host directly', async () => {
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'build server',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'wss://server.example/runtime',
        publicKeyB64: SERVER_KEY,
        deviceToken: 'device-token',
        pairedDeviceId: 'desktop-a'
      }),
      now: 100
    })
    // The phone names the host by the fingerprint the push gateway stamps on the host's own pushes.
    const serverFingerprint = deriveRelayHostId(Buffer.from(SERVER_KEY, 'base64'))
    const day = 86_400_000
    const push = createHarness({
      devices: [
        {
          deviceId: 'phone-paired-with-both',
          pushRegistration: registration({
            registrationId: 'reg-both',
            filter: {
              directAgentAlertHosts: [{ fingerprint: serverFingerprint, until: Date.now() + day }]
            }
          })
        },
        {
          deviceId: 'phone-paired-with-desktop-only',
          pushRegistration: registration({ registrationId: 'reg-desktop-only' })
        },
        {
          deviceId: 'phone-with-lapsed-claim',
          pushRegistration: registration({
            registrationId: 'reg-lapsed',
            filter: {
              directAgentAlertHosts: [{ fingerprint: serverFingerprint, until: Date.now() - 1 }]
            }
          })
        }
      ],
      resolveExecutionHostFingerprints: (executionHost) =>
        resolveExecutionHostPushFingerprints(executionHost, userDataPath)
    })
    let seq = 0
    const desktop = createNotificationDeliveryService({
      readNotificationSettings: () => ({ ...SETTINGS, mutedNotificationSourceIds: [] }),
      findActiveWindow: () => null,
      isWindowVisible: () => false,
      setTrayAttention: vi.fn(),
      isNotificationSupported: () => true,
      dispatchMobileNotification: (event) =>
        push.dispatcher.enqueue({ ...event, notificationSeq: ++seq, notificationEpoch: 'epoch' }),
      readAuthorizationStatus: () => Promise.resolve('authorized'),
      recordDeliveryOutcome: vi.fn(),
      deliverNative: () => ({ delivered: true }),
      platform: 'linux',
      now: Date.now
    })
    const executionHost = `runtime:${environment.id}` as const

    // The window's hook-lane copy of the server's turn.
    desktop.dispatch({
      source: 'agent-task-complete',
      worktreeId: WT,
      executionHost,
      executionHostAnnounces: true,
      agentState: 'done'
    })
    await flush()
    expect(push.sends.flatMap((send) => send.registrationIds).sort()).toEqual([
      'reg-desktop-only',
      'reg-lapsed'
    ])

    // A title-only completion is known only to the desktop, so every phone still gets it.
    push.sends.length = 0
    vi.setSystemTime(Date.now() + day)
    desktop.dispatch({ source: 'agent-task-complete', worktreeId: WT, executionHost })
    await flush()
    expect(push.sends.flatMap((send) => send.registrationIds).sort()).toEqual([
      'reg-both',
      'reg-desktop-only',
      'reg-lapsed'
    ])
  })
})
