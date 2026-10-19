// Runs on plain Node, as orcad does: a server with no window pushes its phones from its own hooks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-transitions'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import type { RuntimeStore } from './runtime-store-contract'

const WT = 'repo-1::/tmp/worktree-a'
const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function createHeadlessHost() {
  const store = {
    getRepos: () => [],
    getRepo: (id: string) =>
      id === 'repo-1' ? { id, connectionId: null, displayName: 'orca' } : undefined,
    getSettings: () => ({ notifications: { enabled: true, agentTaskComplete: true } }),
    getWorktreeMeta: (id: string) => (id === WT ? { displayName: 'feature' } : undefined),
    getAllWorktreeMeta: () => ({})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the push path reads only these members.
  const runtime = new OrcaRuntimeService(store as unknown as RuntimeStore)
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const server = new AgentHookServer()
  runtime.attachAgentStatusStore(server)
  const alerts: MobileNotificationEvent[] = []
  runtime.onNotificationDispatched((event) => alerts.push(event))
  const report = (state: 'working' | 'done' | 'waiting'): void =>
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: WT,
      payload: { state, prompt: 'fix the bug', agentType: 'claude' }
    })
  const agentAlerts = (): (string | undefined)[] =>
    alerts.flatMap((event) =>
      event.type === 'notification' && event.source === 'agent-task-complete'
        ? [event.agentState]
        : []
    )
  return { runtime, report, agentAlerts, alerts }
}

describe('terminal agent phone push on a headless host', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 100_000 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pushes a finish once it stays finished, a request for input at once, and never a prompt', () => {
    const { report, agentAlerts, alerts } = createHeadlessHost()
    report('working')
    report('done')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    vi.advanceTimersByTime(5_000)
    report('working')
    report('waiting')
    expect(agentAlerts()).toEqual(['done', 'waiting'])
    expect(alerts[0]).toMatchObject({ title: 'orca / feature - Claude finished', worktreeId: WT })
  })

  it('holds news a phone has open, and pushes it once that phone lets go', () => {
    const { runtime, report, agentAlerts } = createHeadlessHost()
    const closeSession = runtime.openPhoneWorkspaceSession(WT)
    report('working')
    report('done')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(agentAlerts()).toEqual([])
    closeSession()
    expect(agentAlerts()).toEqual(['done'])
  })

  it('answers the window’s request for the same news as already delivered', () => {
    const { runtime, report, alerts } = createHeadlessHost()
    report('working')
    report('done')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    const pushed = alerts[0]
    const notificationId = pushed?.type === 'notification' ? pushed.notificationId : undefined
    const windowRequest = {
      source: 'agent-task-complete',
      paneKey: PANE,
      worktreeId: WT,
      agentState: 'done',
      notificationId
    } as const
    expect(notificationId).toBeTruthy()
    expect(runtime.terminalAgentNewsDeliveredByHost(windowRequest)).toEqual({ notificationId })
    report('working')
    expect(runtime.terminalAgentNewsDeliveredByHost(windowRequest)).toBeNull()
  })
})
