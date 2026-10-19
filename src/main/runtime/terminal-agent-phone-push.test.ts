import { describe, expect, it } from 'vitest'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AgentTransition } from '../../shared/agent-transitions'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'
import { createNotificationDeliveryService } from '../notifications/notification-delivery-service'
import { PHONE_LOOKING_LINGER_MS, TerminalAgentPhonePush } from './terminal-agent-phone-push'

const WT = 'repo-1::/tmp/wt'
const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    state: 'done',
    prompt: 'fix the bug',
    agentType: 'claude',
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 5_000,
    lastAssistantMessage: 'Fixed it.',
    ...overrides
  }
}

function moved(
  transition: AgentTransition | null,
  to: 'done' | 'needs-you' | 'working' | 'rest' = 'done'
): AgentPaneChange {
  return {
    kind: 'moved',
    paneKey: PANE,
    workspace: { worktreeId: WT, sshHostId: null },
    from: 'working',
    to,
    at: 1,
    transition
  }
}

function harness(
  options: {
    settings?: Partial<NotificationSettings>
    muted?: boolean
    hookRow?: AgentStatusIpcPayload | null
  } = {}
) {
  const clock = { now: 10_000 }
  const sent: MobileNotificationDispatchEvent[] = []
  const looking = new Set<string>()
  const state = { muted: options.muted ?? false, hookRow: options.hookRow ?? row() }
  const push = new TerminalAgentPhonePush({
    readNotificationSettings: () => ({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: true,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 1,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: true,
      ...options.settings
    }),
    readWorkspaceLabels: () => ({ repoLabel: 'orca', worktreeLabel: 'feature' }),
    isWorkspaceMuted: () => state.muted,
    isPhoneLooking: (worktreeId) => looking.has(worktreeId),
    readHookRow: () => state.hookRow,
    dispatch: (event) => sent.push(event),
    now: () => clock.now
  })
  return { push, sent, clock, looking, state }
}

describe('TerminalAgentPhonePush', () => {
  it('pushes a finished turn with the window’s wording and id', () => {
    const { push, sent } = harness()
    push.observe(moved('turn-finished'))
    expect(sent).toEqual([
      {
        type: 'notification',
        source: 'agent-task-complete',
        title: 'orca / feature - Claude finished',
        body: 'Fixed it.',
        worktreeId: WT,
        notificationId: `agent:${encodeURIComponent(WT)}:${encodeURIComponent(PANE)}:5000`,
        agentState: 'done',
        emittedAt: 10_000
      }
    ])
  })

  it('pushes an agent that needs input, and a failed turn as finished', () => {
    const { push, sent, state } = harness({
      hookRow: row({
        state: 'waiting',
        lastAssistantMessage: undefined,
        toolName: 'Bash',
        toolInput: 'rm -rf build'
      })
    })
    push.observe(moved('needs-input', 'needs-you'))
    state.hookRow = row({ mainAgent: { state: 'done', outcome: 'failure' } })
    push.observe(moved('errored'))
    expect(sent.map((event) => [event.agentState, event.title, event.body])).toEqual([
      ['waiting', 'orca / feature - Claude needs input', 'Using Bash: rm -rf build'],
      ['done', 'orca / feature - Claude failed', 'Fixed it.']
    ])
  })

  it('pushes nothing for a prompt, a resume, a rest, or a structured chat’s row', () => {
    const { push, sent, state } = harness()
    push.observe(moved('prompt-submitted', 'working'))
    push.observe(moved(null, 'working'))
    push.observe(moved(null, 'rest'))
    push.observe({
      kind: 'seeded',
      paneKey: PANE,
      workspace: moved(null).workspace,
      phase: 'done',
      at: 1
    })
    state.hookRow = row({ structuredHost: { owned: true } })
    push.observe(moved('turn-finished'))
    expect(sent).toEqual([])
  })

  it('pushes nothing for a muted workspace, yet still owns that news', () => {
    const { push, sent } = harness({ muted: true })
    push.observe(moved('turn-finished'))
    expect(sent).toEqual([])
    expect(push.coveringNews({ source: 'agent-task-complete', paneKey: PANE })).not.toBeNull()
  })

  it('marks the push not desktop-allowed when agent notifications are off', () => {
    const { push, sent } = harness({ settings: { agentTaskComplete: false } })
    push.observe(moved('turn-finished'))
    expect(sent[0]?.desktopAllowed).toBe(false)
  })

  it('drops news a phone keeps looking at past the linger', () => {
    const { push, sent, clock, looking } = harness()
    looking.add(WT)
    push.observe(moved('turn-finished'))
    expect(sent).toEqual([])
    clock.now += PHONE_LOOKING_LINGER_MS + 1
    looking.delete(WT)
    push.notePhoneSessionClosed(WT)
    expect(sent).toEqual([])
  })

  it('pushes held news once a locked phone’s lingering session ends', () => {
    const { push, sent, clock, looking } = harness()
    looking.add(WT)
    push.observe(moved('turn-finished'))
    clock.now += 45_000
    // Another phone is still looking: nothing yet.
    push.notePhoneSessionClosed(WT)
    expect(sent).toEqual([])
    looking.delete(WT)
    push.notePhoneSessionClosed(WT)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.emittedAt).toBe(55_000)
    // Delivered once.
    push.notePhoneSessionClosed(WT)
    expect(sent).toHaveLength(1)
  })

  it('drops held news when the pane moves on before the phone lets go', () => {
    const { push, sent, looking } = harness()
    looking.add(WT)
    push.observe(moved('needs-input', 'needs-you'))
    push.observe(moved(null, 'working'))
    looking.delete(WT)
    push.notePhoneSessionClosed(WT)
    expect(sent).toEqual([])
  })

  it('rechecks the mute before pushing held news', () => {
    const { push, sent, looking, state } = harness()
    looking.add(WT)
    push.observe(moved('turn-finished'))
    state.muted = true
    looking.delete(WT)
    push.notePhoneSessionClosed(WT)
    expect(sent).toEqual([])
  })

  describe('covering the window’s request for the same news', () => {
    it('covers this host’s pane while its news stands, by kind', () => {
      const { push } = harness()
      push.observe(moved('turn-finished'))
      const id = `agent:${encodeURIComponent(WT)}:${encodeURIComponent(PANE)}:5000`
      expect(
        push.coveringNews({ source: 'agent-task-complete', paneKey: PANE, agentState: 'done' })
      ).toEqual({ notificationId: id })
      // A title-only completion carries no state and still reads as finished.
      expect(push.coveringNews({ source: 'agent-task-complete', paneKey: PANE })).toEqual({
        notificationId: id
      })
      expect(
        push.coveringNews({ source: 'agent-task-complete', paneKey: PANE, agentState: 'blocked' })
      ).toBeNull()
    })

    it('leaves the bell, a paired server’s pane, and news the pane moved past to the window', () => {
      const { push } = harness()
      push.observe(moved('turn-finished'))
      expect(push.coveringNews({ source: 'terminal-bell', paneKey: PANE })).toBeNull()
      expect(
        push.coveringNews({
          source: 'agent-task-complete',
          paneKey: PANE,
          executionHost: 'runtime:env-1'
        })
      ).toBeNull()
      push.observe(moved('prompt-submitted', 'working'))
      expect(push.coveringNews({ source: 'agent-task-complete', paneKey: PANE })).toBeNull()
    })

    it('covers held and looked-at news too, so the window’s copy does not push around it', () => {
      const { push, looking } = harness()
      looking.add(WT)
      push.observe(moved('turn-finished'))
      expect(push.coveringNews({ source: 'agent-task-complete', paneKey: PANE })).not.toBeNull()
    })
  })

  it('sends phones, old ones included, the alert the window’s own request would have', () => {
    const { push, sent } = harness()
    push.observe(moved('turn-finished'))
    const fromWindow: MobileNotificationDispatchEvent[] = []
    const service = createNotificationDeliveryService({
      readNotificationSettings: () => ({
        enabled: false,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: true,
        customSoundId: 'system',
        customSoundPath: null,
        customSoundVolume: 1,
        mutedNotificationSourceIds: [],
        notifyHiddenWorkspaces: true
      }),
      findActiveWindow: () => null,
      isWindowVisible: () => false,
      setTrayAttention: () => {},
      isNotificationSupported: () => false,
      dispatchMobileNotification: (event) => fromWindow.push(event),
      readAuthorizationStatus: async () => null,
      recordDeliveryOutcome: () => {},
      deliverNative: () => ({ delivered: false }),
      platform: 'linux',
      now: () => 10_000
    })
    void service.dispatch({
      source: 'agent-task-complete',
      notificationId: sent[0]?.notificationId,
      worktreeId: WT,
      paneKey: PANE,
      repoLabel: 'orca',
      worktreeLabel: 'feature',
      agentType: 'claude',
      agentState: 'done',
      agentPrompt: 'fix the bug',
      agentLastAssistantMessage: 'Fixed it.'
    })
    // The window's request was made with desktop banners off; only that flag differs.
    expect(fromWindow).toEqual([{ ...sent[0], desktopAllowed: false }])
  })
})
