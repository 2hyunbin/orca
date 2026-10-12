import { describe, expect, it } from 'vitest'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import { focusInViewRecord } from './workspace-layout-view-focus'
import { emptyLayoutViewRecord } from './workspace-layout-views'

function twoTabsSecondSplit() {
  const context = testContext()
  const { model } = build(context, [
    { type: 'createTerminalTab', workspace: WS },
    { type: 'createTerminalTab', workspace: WS }
  ])
  const second = model.workspaces[WS]!.tabs[1]!
  const root = second.kind === 'terminal' ? second.panes.root : null
  const leafId = root?.type === 'leaf' ? root.leafId : ''
  const { model: split } = build(
    context,
    [{ type: 'splitPane', workspace: WS, tabId: second.id, leafId, direction: 'vertical' }],
    model
  )
  return split.workspaces[WS]!
}

describe('focusInViewRecord', () => {
  it('shows the tab in its group, makes that group active and focuses the pane', () => {
    const workspace = twoTabsSecondSplit()
    const tab = workspace.tabs[1]!
    const group = workspace.groups[0]!
    const leafIds = tab.kind === 'terminal' ? collectLayoutLeafIdsInOrder(tab.panes.root) : []
    const record = focusInViewRecord(emptyLayoutViewRecord(), WS, workspace, {
      tabId: tab.id,
      leafId: leafIds.at(-1)!
    })

    expect(record.activeGroupIdByWorktree?.[WS]).toBe(group.id)
    expect(record.groups[WS]?.[group.id]).toEqual({ activeTabId: tab.id, recentTabIds: [tab.id] })
    expect(record.panes[tab.entityId]).toEqual({
      activeLeafId: leafIds.at(-1),
      expandedLeafId: null
    })
  })

  it('leaves the record as it was for a tab the workspace does not hold', () => {
    const workspace = twoTabsSecondSplit()
    const record = emptyLayoutViewRecord()
    expect(focusInViewRecord(record, WS, workspace, { tabId: 'gone' })).toBe(record)
  })
})
