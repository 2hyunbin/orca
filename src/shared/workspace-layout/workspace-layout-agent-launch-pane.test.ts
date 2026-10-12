import { describe, expect, it } from 'vitest'
import { setAgentLaunchPane } from './workspace-layout-agent-launch-pane'
import { build, terminalTab, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

function setup() {
  const created = build(testContext(), [{ type: 'createTerminalTab', workspace: WS }])
  const { tabId, leafId } = created.results[0]!
  return { model: created.model, tabId: tabId!, leafId: leafId! }
}

function set(...args: Parameters<typeof setAgentLaunchPane>): WorkspaceLayoutModel {
  const result = setAgentLaunchPane(...args)
  if (!result.ok) {
    throw new Error(result.code)
  }
  return result.model
}

describe('a terminal tab’s agent-launch pane', () => {
  it('records the launch that laid out the pane, then its final outcome', () => {
    const { model, tabId, leafId } = setup()

    const laid = set(model, WS, tabId, { leafId, operationId: 'op-1' })
    expect(terminalTab(laid, tabId).terminal.agentLaunchPane).toEqual({
      leafId,
      operationId: 'op-1'
    })

    const failed = set(laid, WS, tabId, {
      leafId,
      operationId: 'op-1',
      outcome: { kind: 'not-started', code: 'agent_not_found' }
    })
    expect(terminalTab(failed, tabId).terminal.agentLaunchPane?.outcome).toEqual({
      kind: 'not-started',
      code: 'agent_not_found'
    })
  })

  it('forgets the launch pane when cleared', () => {
    const { model, tabId, leafId } = setup()
    const laid = set(model, WS, tabId, { leafId })

    const cleared = set(laid, WS, tabId, null)

    expect(terminalTab(cleared, tabId).terminal).not.toHaveProperty('agentLaunchPane')
  })

  it('leaves the model alone for a tab the layout no longer has', () => {
    const { model, leafId } = setup()

    expect(set(model, WS, 'gone', { leafId })).toBe(model)
    expect(set(model, 'repo-x::/missing', 'gone', null)).toBe(model)
  })
})
