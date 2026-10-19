// Runs on plain Node, as orcad does: a server with no window pushes its phones from its own hooks.
import { describe, expect, it, vi } from 'vitest'
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
  it('pushes a finish and a request for input, and never a prompt', async () => {
    const { report, agentAlerts, alerts } = createHeadlessHost()
    report('working')
    report('done')
    report('working')
    report('waiting')
    await vi.waitFor(() => expect(agentAlerts()).toEqual(['done', 'waiting']))
    expect(alerts[0]).toMatchObject({ title: 'orca / feature - Claude finished', worktreeId: WT })
  })

  it('holds news a phone has open, and pushes it once that phone lets go', async () => {
    const { runtime, report, agentAlerts } = createHeadlessHost()
    const closeSession = runtime.openPhoneWorkspaceSession(WT)
    report('working')
    report('done')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(agentAlerts()).toEqual([])
    closeSession()
    await vi.waitFor(() => expect(agentAlerts()).toEqual(['done']))
  })

  it('answers the window’s request for the same news as already delivered', () => {
    const { runtime, report } = createHeadlessHost()
    report('working')
    report('done')
    expect(
      runtime.terminalAgentNewsDeliveredByHost({
        source: 'agent-task-complete',
        paneKey: PANE,
        agentState: 'done'
      })
    ).not.toBeNull()
    report('working')
    expect(
      runtime.terminalAgentNewsDeliveredByHost({ source: 'agent-task-complete', paneKey: PANE })
    ).toBeNull()
  })
})
