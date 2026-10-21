import { afterEach, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from './runtime-mobile-notification-controller'
import {
  createTerminalAgentMobileAttention,
  HOST_HOOK_DONE_QUIET_MS
} from './terminal-agent-mobile-attention'

afterEach(() => vi.useRealTimers())

it('delivers headless terminal news and retires its exact alerts only on a newer start of the same run', () => {
  vi.useFakeTimers()
  const controller = new RuntimeMobileNotificationController()
  const sent: MobileNotificationEvent[] = []
  controller.onDispatched((event) => sent.push(event))
  let row: AgentStatusIpcPayload = {
    paneKey: 'tab:leaf',
    connectionId: null,
    receivedAt: 100,
    state: 'working',
    agentType: 'codex',
    prompt: 'Work',
    worktreeId: 'workspace-1',
    stateStartedAt: 100,
    turnStartedAt: 100,
    runId: 'run-1',
    executionId: 'execution-1',
    terminalHandle: 'terminal-1'
  }
  const producer = createTerminalAgentMobileAttention({
    readRow: () => row,
    readNotificationSettings: () => ({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 1,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: true
    }),
    readWorkspaceLabels: () => ({}),
    isWorkspaceMuted: () => false,
    dispatch: (event) => controller.dispatch(event),
    retire: (alerts) => controller.retireLiveNotifications(alerts),
    now: Date.now
  })
  const observe = (kind: 'seeded' | 'observed' = 'observed') =>
    producer.observe({
      kind,
      paneKey: row.paneKey,
      workspace: { worktreeId: 'workspace-1', sshHostId: null },
      phase: 'working',
      at: Date.now()
    })
  const notifications = () => sent.filter((event) => event.type === 'notification')
  const dismissals = () => sent.filter((event) => event.type === 'dismiss')
  try {
    observe('seeded')
    row = { ...row, state: 'blocked', stateStartedAt: 200 }
    observe()
    row = { ...row, state: 'done', stateStartedAt: 300, turnCompletedAt: 300 }
    observe()
    vi.advanceTimersByTime(HOST_HOOK_DONE_QUIET_MS)
    expect(notifications()).toHaveLength(2)
    row = { ...row, prompt: 'Metadata update' }
    observe()
    expect(dismissals()).toEqual([])
    row = {
      ...row,
      state: 'working',
      stateStartedAt: 400,
      turnStartedAt: 400,
      turnCompletedAt: undefined
    }
    observe()
    observe()
    expect(dismissals().map((event) => event.dismissedDelivery)).toEqual(
      notifications().map((event) => ({
        notificationId: event.notificationId,
        notificationEpoch: event.notificationEpoch,
        notificationSeq: event.notificationSeq
      }))
    )
    row = { ...row, state: 'blocked', stateStartedAt: 500 }
    observe()
    row = {
      ...row,
      state: 'working',
      runId: 'replacement-run',
      turnStartedAt: 600,
      stateStartedAt: 600
    }
    observe()
    expect(dismissals()).toHaveLength(2)
    row = { ...row, state: 'done', stateStartedAt: 700, isReplay: true }
    observe()
    vi.advanceTimersByTime(HOST_HOOK_DONE_QUIET_MS)
    expect(notifications()).toHaveLength(3)
  } finally {
    producer.dispose()
  }
})
