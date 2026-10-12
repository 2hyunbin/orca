import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchPaneVerdict } from '../../shared/agent-launch-pane-verdict'
import { findTerminal } from '../../shared/workspace-layout/workspace-layout-command-steps'
import { GIT_KEY, leaf } from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import {
  AgentLaunchHeldTabs,
  applyAgentLaunchPaneVerdict,
  showAgentLaunchTab,
  type AgentLaunchTabHost,
  type AgentLaunchTabRequest
} from './agent-launch-held-tab'
import { fakeStore, gitSession, holderFor } from './runtime-workspace-layouts.test-fixture'

const LAUNCH_TAB = 'launch-tab'
const LAUNCH_LEAF = leaf(7)

function setup() {
  const store = fakeStore({ local: gitSession() })
  const { holder } = holderFor(store)
  const host: AgentLaunchTabHost = {
    holder,
    desktopActiveGroup: () => ({ groupId: 'group-a' }),
    focusInDesktopView: vi.fn(),
    navigateDesktopView: vi.fn()
  }
  return { holder, host }
}

function request(overrides: Partial<AgentLaunchTabRequest> = {}): AgentLaunchTabRequest {
  return {
    worktreeId: GIT_KEY,
    tabId: LAUNCH_TAB,
    leafId: LAUNCH_LEAF,
    launchAgent: 'claude',
    viewMode: 'terminal',
    viewer: 'none',
    operationId: 'op-1',
    ...overrides
  }
}

function launchTab(host: AgentLaunchTabHost, tabId = LAUNCH_TAB) {
  const model = host.holder.model('local')!
  return findTerminal(model.workspaces[GIT_KEY]!, tabId)
}

const verdictFor = (verdict: AgentLaunchPaneVerdict, leafId = LAUNCH_LEAF) => ({
  worktreeId: GIT_KEY,
  tabId: LAUNCH_TAB,
  leafId,
  verdict
})

describe('showing an agent launch’s tab', () => {
  it('creates the tab in the requested group, with the launch’s pane recorded', () => {
    const { host } = setup()

    const shown = showAgentLaunchTab(host, request({ placement: { groupId: 'group-a' } }))

    expect(shown?.published).toEqual({
      tabId: LAUNCH_TAB,
      created: true,
      placement: { groupId: 'group-a' }
    })
    expect(launchTab(host)?.terminal.agentLaunchPane).toEqual({
      leafId: LAUNCH_LEAF,
      operationId: 'op-1'
    })
  })

  it('lands in the active group when the requested group is gone, and says so', () => {
    const { host } = setup()

    const shown = showAgentLaunchTab(host, request({ placement: { groupId: 'group-missing' } }))

    expect(shown?.published.placement).toEqual({ groupId: 'group-a', fallback: 'active-group' })
  })

  it('finds the tab a retry names instead of making a second one', () => {
    const { host } = setup()
    showAgentLaunchTab(host, request())

    const retried = showAgentLaunchTab(host, request())

    expect(retried).toEqual({
      published: { tabId: LAUNCH_TAB, created: false, placement: { groupId: 'group-a' } },
      start: null
    })
    expect(host.holder.published(GIT_KEY)?.tabs.map((tab) => tab.id)).toEqual(['tab-1', LAUNCH_TAB])
  })

  it('resets what an earlier launch left on the pane when a different launch reuses it', () => {
    const { host, holder } = setup()
    showAgentLaunchTab(host, request())
    applyAgentLaunchPaneVerdict(holder, verdictFor({ kind: 'not-started', code: 'spawn_failed' }))

    showAgentLaunchTab(host, request({ operationId: 'op-2' }))

    expect(launchTab(host)?.terminal.agentLaunchPane).toEqual({
      leafId: LAUNCH_LEAF,
      operationId: 'op-2'
    })
  })

  it('shows nothing when the runtime does not hold the workspace’s layout', () => {
    const { host } = setup()

    expect(showAgentLaunchTab(host, request({ worktreeId: 'repo-x::/unknown' }))).toBeNull()
  })
})

describe('a launch’s verdict on its pane', () => {
  it('forgets the launch pane once its agent runs', () => {
    const { host, holder } = setup()
    showAgentLaunchTab(host, request())

    applyAgentLaunchPaneVerdict(holder, verdictFor({ kind: 'proceed' }))

    expect(launchTab(host)?.terminal).not.toHaveProperty('agentLaunchPane')
  })

  it('keeps a not-started outcome on the tab and ends the pane’s start as failed', () => {
    const { host, holder } = setup()
    const tabs = new AgentLaunchHeldTabs(host)
    const endStart = vi.spyOn(holder, 'endStart')
    tabs.show(request())
    const outcome = { kind: 'not-started', code: 'spawn_failed' } as const

    tabs.verdict(verdictFor(outcome))

    expect(launchTab(host)?.terminal.agentLaunchPane).toEqual({
      leafId: LAUNCH_LEAF,
      operationId: 'op-1',
      outcome
    })
    expect(endStart).toHaveBeenCalledWith(
      'local',
      GIT_KEY,
      expect.objectContaining({ paneKey: `${LAUNCH_TAB}:${LAUNCH_LEAF}` }),
      'failed'
    )
  })

  it('closes the tab of a withdrawn launch whose pane is the tab’s only one', () => {
    const { host, holder } = setup()
    showAgentLaunchTab(host, request())

    applyAgentLaunchPaneVerdict(holder, verdictFor({ kind: 'withdrawn' }))

    expect(launchTab(host)).toBeUndefined()
  })

  it('closes only the withdrawn pane when the user split its tab', () => {
    const { host, holder } = setup()
    showAgentLaunchTab(host, request())
    const split = holder.apply({
      type: 'splitPane',
      workspace: GIT_KEY,
      tabId: LAUNCH_TAB,
      leafId: LAUNCH_LEAF,
      direction: 'vertical',
      newLeafId: leaf(8)
    })
    expect(split.ok).toBe(true)

    applyAgentLaunchPaneVerdict(holder, verdictFor({ kind: 'withdrawn' }))

    const tab = launchTab(host)
    expect(tab?.panes.root).toEqual({ type: 'leaf', leafId: leaf(8) })
    expect(tab?.terminal).not.toHaveProperty('agentLaunchPane')
  })

  it('ignores a verdict for a pane the tab no longer says a launch laid out', () => {
    const { host, holder } = setup()
    showAgentLaunchTab(host, request())
    applyAgentLaunchPaneVerdict(holder, verdictFor({ kind: 'proceed' }))
    const before = holder.model('local')

    applyAgentLaunchPaneVerdict(holder, verdictFor({ kind: 'withdrawn' }))
    applyAgentLaunchPaneVerdict(holder, verdictFor({ kind: 'unconfirmed' }, leaf(9)))

    expect(holder.model('local')).toBe(before)
  })
})
