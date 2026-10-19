import { describe, expect, it } from 'vitest'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { AGENT_DONE_QUIET_MS, type AgentTransition } from '../../shared/agent-transitions'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import type {
  MobileNotificationDispatchEvent,
  MobileNotificationEvent
} from './runtime-mobile-notification-controller'
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
  const timers: { at: number; run: () => void; cancelled: boolean }[] = []
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
    setTimer: (run, delayMs) => {
      const timer = { at: clock.now + delayMs, run, cancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.cancelled = true) }
    },
    now: () => clock.now
  })
  const advance = (ms: number): void => {
    clock.now += ms
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) {
        continue
      }
      if (timer.at <= clock.now) {
        timer.run()
      } else {
        timers.push(timer)
      }
    }
  }
  return { push, sent, clock, looking, state, advance }
}

const ID = `agent:${encodeURIComponent(WT)}:${encodeURIComponent(PANE)}:5000`
const windowFinish = { source: 'agent-task-complete', paneKey: PANE, worktreeId: WT } as const

describe('TerminalAgentPhonePush', () => {
  it('pushes a finished turn once its quiet window passes, with the window’s wording and id', () => {
    const { push, sent, advance } = harness()
    push.observe(moved('turn-finished'))
    expect(sent).toEqual([])
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([
      {
        type: 'notification',
        source: 'agent-task-complete',
        title: 'orca / feature - Claude finished',
        body: 'Fixed it.',
        worktreeId: WT,
        notificationId: ID,
        agentState: 'done',
        emittedAt: 11_500
      }
    ])
  })

  it('announces no milestone a goal agent resumes from within the quiet window', () => {
    const { push, sent, advance } = harness()
    push.observe(moved('turn-finished'))
    advance(500)
    push.observe(moved(null, 'working'))
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([])
  })

  it('announces a lead agent’s finish while background work runs, and not its later all-clear', () => {
    const { push, sent, state, advance } = harness()
    const observed = (): AgentPaneChange => ({
      kind: 'observed',
      paneKey: PANE,
      workspace: { worktreeId: WT, sshHostId: null },
      phase: 'working',
      at: 1
    })
    state.hookRow = row({ state: 'working', stateStartedAt: 1_000, turnCompletedAt: 7_000 })
    push.observe(observed())
    // A background task's ping on the same turn is no news.
    push.observe(observed())
    // At once, as the window announces it.
    expect(sent.map((event) => [event.agentState, event.notificationId])).toEqual([
      ['done', ID.replace(':5000', ':7000')]
    ])
    advance(5_000)
    state.hookRow = row({ stateStartedAt: 9_000, turnCompletedAt: 7_000 })
    push.observe(moved('turn-finished'))
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toHaveLength(1)
    // The all-clear leaves the finish standing, so the window's copy stays covered.
    expect(
      push.coveringNews({ ...windowFinish, notificationId: ID.replace(':5000', ':7000') })
    ).not.toBeNull()
  })

  it('pushes a lead agent’s finish held for a looking phone even after the all-clear', () => {
    const { push, sent, state, looking } = harness()
    looking.add(WT)
    state.hookRow = row({ state: 'working', turnCompletedAt: 7_000 })
    push.observe({
      kind: 'observed',
      paneKey: PANE,
      workspace: { worktreeId: WT, sshHostId: null },
      phase: 'working',
      at: 1
    })
    state.hookRow = row({ turnCompletedAt: 7_000 })
    push.observe(moved('turn-finished'))
    looking.delete(WT)
    push.notePhoneSessionClosed(WT)
    expect(sent).toHaveLength(1)
  })

  it('announces no finish restored with the pane', () => {
    const { push, sent, state, advance } = harness({
      hookRow: row({ state: 'working', turnCompletedAt: 7_000 })
    })
    const workspace = { worktreeId: WT, sshHostId: null }
    push.observe({ kind: 'seeded', paneKey: PANE, workspace, phase: 'working', at: 1 })
    push.observe({ kind: 'observed', paneKey: PANE, workspace, phase: 'working', at: 1 })
    state.hookRow = row({ turnCompletedAt: 7_000 })
    push.observe(moved('turn-finished'))
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([])
  })

  it('pushes an agent that needs input at once, and a failed turn as finished', () => {
    const { push, sent, state, advance } = harness({
      hookRow: row({
        state: 'waiting',
        lastAssistantMessage: undefined,
        toolName: 'Bash',
        toolInput: 'rm -rf build'
      })
    })
    push.observe(moved('needs-input', 'needs-you'))
    expect(sent).toHaveLength(1)
    // Past the burst gate the window's fan-out applies per workspace.
    advance(5_000)
    state.hookRow = row({ mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 5_000 } })
    push.observe(moved('errored'))
    advance(AGENT_DONE_QUIET_MS)
    expect(sent.map((event) => [event.agentState, event.title, event.body])).toEqual([
      ['waiting', 'orca / feature - Claude needs input', 'Using Bash: rm -rf build'],
      ['done', 'orca / feature - Claude failed', 'Fixed it.']
    ])
  })

  it('collapses a burst in one workspace as the window’s fan-out does', () => {
    const { push, sent, advance } = harness()
    push.observe(moved('turn-finished'))
    advance(AGENT_DONE_QUIET_MS)
    push.observe(moved('prompt-submitted', 'working'))
    push.observe(moved('turn-finished'))
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toHaveLength(1)
  })

  it('pushes nothing for a prompt, a resume, a rest, or a structured chat’s row', () => {
    const { push, sent, state, advance } = harness()
    push.observe(moved('prompt-submitted', 'working'))
    push.observe(moved(null, 'working'))
    push.observe(moved(null, 'rest'))
    push.observe({
      kind: 'seeded',
      paneKey: PANE,
      workspace: { worktreeId: WT, sshHostId: null },
      phase: 'done',
      at: 1
    })
    state.hookRow = row({ structuredHost: 'owned' })
    push.observe(moved('turn-finished'))
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([])
  })

  it('pushes nothing for a muted workspace, yet still owns that news', () => {
    const { push, sent, advance } = harness({ muted: true })
    push.observe(moved('turn-finished'))
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([])
    expect(push.coveringNews({ ...windowFinish, notificationId: ID })).not.toBeNull()
  })

  it('marks the push not desktop-allowed when agent notifications are off', () => {
    const { push, sent } = harness({
      settings: { agentTaskComplete: false },
      hookRow: row({ state: 'blocked' })
    })
    push.observe(moved('needs-input', 'needs-you'))
    expect(sent[0]?.desktopAllowed).toBe(false)
  })

  it('drops news a phone keeps looking at past the linger', () => {
    const { push, sent, looking, advance } = harness()
    looking.add(WT)
    push.observe(moved('turn-finished'))
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([])
    advance(PHONE_LOOKING_LINGER_MS + 1)
    looking.delete(WT)
    push.notePhoneSessionClosed(WT)
    expect(sent).toEqual([])
  })

  it('pushes held news once a locked phone’s lingering session ends', () => {
    const { push, sent, looking, advance } = harness()
    looking.add(WT)
    push.observe(moved('turn-finished'))
    advance(45_000)
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
    const { push, sent, looking } = harness({ hookRow: row({ state: 'waiting' }) })
    looking.add(WT)
    push.observe(moved('needs-input', 'needs-you'))
    push.observe(moved(null, 'working'))
    looking.delete(WT)
    push.notePhoneSessionClosed(WT)
    expect(sent).toEqual([])
  })

  it('rechecks the mute before pushing held news', () => {
    const { push, sent, looking, state, advance } = harness()
    looking.add(WT)
    push.observe(moved('turn-finished'))
    advance(AGENT_DONE_QUIET_MS)
    state.muted = true
    looking.delete(WT)
    push.notePhoneSessionClosed(WT)
    expect(sent).toEqual([])
  })

  describe('covering the window’s request for the same news', () => {
    it('covers the request minted from the same hook row, in the request’s own spelling', () => {
      const { push } = harness()
      push.observe(moved('turn-finished'))
      expect(push.coveringNews({ ...windowFinish, notificationId: ID })).toEqual({
        notificationId: ID
      })
      const spelled = 'repo-1::/tmp/wt/'
      expect(
        push.coveringNews({
          ...windowFinish,
          worktreeId: spelled,
          notificationId: `agent:${encodeURIComponent(spelled)}:${encodeURIComponent(PANE)}:5000`
        })
      ).toEqual({ notificationId: ID })
    })

    it('leaves the window its own news: another turn, a title or exit completion, the bell, a paired server’s pane', () => {
      const { push } = harness()
      push.observe(moved('turn-finished'))
      expect(
        push.coveringNews({ ...windowFinish, notificationId: ID.replace(':5000', ':6000') })
      ).toBeNull()
      expect(push.coveringNews(windowFinish)).toBeNull()
      expect(
        push.coveringNews({ ...windowFinish, source: 'terminal-bell', notificationId: ID })
      ).toBeNull()
      expect(
        push.coveringNews({ ...windowFinish, notificationId: ID, executionHost: 'runtime:env-1' })
      ).toBeNull()
      push.observe(moved('prompt-submitted', 'working'))
      expect(push.coveringNews({ ...windowFinish, notificationId: ID })).toBeNull()
    })

    it('covers held and looked-at news too, so the window’s copy does not push around it', () => {
      const { push, looking, advance } = harness()
      looking.add(WT)
      push.observe(moved('turn-finished'))
      advance(AGENT_DONE_QUIET_MS)
      expect(push.coveringNews({ ...windowFinish, notificationId: ID })).not.toBeNull()
    })
  })

  it('sends phones, old ones included, the alert the window’s own request would have', () => {
    const { push, sent, advance } = harness()
    push.observe(moved('turn-finished'))
    advance(AGENT_DONE_QUIET_MS)
    const fromWindow: MobileNotificationEvent[] = []
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
      now: () => 11_500
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
