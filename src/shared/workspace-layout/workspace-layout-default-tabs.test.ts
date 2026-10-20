import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import { build, terminalTab, testContext, WS } from './workspace-layout-command.test-fixture'

describe('applyDefaultTabs', () => {
  it('makes every default tab with its title and colour, and the mark, in one command', () => {
    const { model, results } = build(testContext(), [
      {
        type: 'applyDefaultTabs',
        workspace: WS,
        tabs: [
          { title: 'Server', color: 'blue', creation: { launchAgent: 'claude' } },
          {},
          { title: 'Logs' }
        ]
      }
    ])
    const created = results[0]!.createdTabs!
    expect(created).toHaveLength(3)
    expect(model.workspaces[WS]!.groups[0]!.tabOrder).toEqual(created.map((tab) => tab.tabId))
    const [first, second, third] = created.map((tab) => terminalTab(model, tab.tabId))
    expect(first).toMatchObject({ customTitle: 'Server', color: 'blue' })
    expect(first!.terminal).toMatchObject({ defaultTitle: 'Terminal 1', launchAgent: 'claude' })
    expect(second).toMatchObject({ customTitle: null, color: null })
    expect(second!.terminal.defaultTitle).toBe('Terminal 2')
    expect(third!.customTitle).toBe('Logs')
    expect(created.map((tab) => tab.paneKey)).toEqual(
      created.map((tab) => `${tab.tabId}:${tab.leafId}`)
    )
    expect(model.records.defaultTabsAppliedByWorkspace).toEqual({ [WS]: true })
  })

  it('starts every new pane', () => {
    const applied = applyLayoutCommand(
      build(testContext(), []).model,
      { type: 'applyDefaultTabs', workspace: WS, tabs: [{}, {}] },
      testContext()
    )
    expect(applied.ok && applied.effects.startPaneKeys).toEqual(
      applied.ok ? applied.result.createdTabs!.map((tab) => tab.paneKey) : []
    )
  })

  it('makes nothing once a workspace’s default tabs were applied', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [
      { type: 'applyDefaultTabs', workspace: WS, tabs: [{ title: 'Server' }] },
      { type: 'applyDefaultTabs', workspace: WS, tabs: [{ title: 'Again' }] }
    ])
    expect(results[1]!.createdTabs).toEqual([])
    expect(model.workspaces[WS]!.tabs).toHaveLength(1)
  })

  it('marks a workspace with no templates without creating it', () => {
    const { model, results } = build(testContext(), [
      { type: 'applyDefaultTabs', workspace: WS, tabs: [] }
    ])
    expect(results[0]!.createdTabs).toEqual([])
    expect(model.workspaces[WS]).toBeUndefined()
    expect(model.records.defaultTabsAppliedByWorkspace).toEqual({ [WS]: true })
  })
})
