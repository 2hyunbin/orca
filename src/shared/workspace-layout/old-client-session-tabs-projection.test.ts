import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../runtime-session-contracts'
import { resolveSessionTabRow } from './old-client-session-tab-rows'
import {
  projectSessionTabs,
  type SessionTabsFacts,
  type SessionTabsView
} from './old-client-session-tabs-projection'
import { BLANK_BROWSER_TAB_STATE } from './workspace-layout-beside'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

/**
 * A workspace as a desktop leaves it: a renamed terminal tab split in two (one pane titled, both
 * bound), an agent terminal, a markdown file, a browser tab and a chat, with the chat and the
 * browser in a second group to the right.
 */
function workspace() {
  const ctx = testContext()
  const { model, results } = build(ctx, [
    { type: 'createTerminalTab', workspace: WS, title: 'api server' },
    {
      type: 'createTerminalTab',
      workspace: WS,
      creation: { launchAgent: 'claude', startupCwd: '/Users/dev/orca' }
    },
    {
      type: 'openEditorTab',
      workspace: WS,
      fileId: '/Users/dev/orca/README.md',
      contentType: 'editor',
      file: {
        filePath: '/Users/dev/orca/README.md',
        relativePath: 'README.md',
        language: 'markdown'
      }
    },
    { type: 'openBrowserTab', workspace: WS },
    { type: 'openAgentSessionTab', workspace: WS, sessionId: 'session-1', agent: 'codex' }
  ])
  const [api, agent, readme, browser, chat] = results
  const left = groupOf(model, api!.tabId!)
  const arranged = build(
    ctx,
    [
      {
        type: 'splitPane',
        workspace: WS,
        tabId: api!.tabId!,
        leafId: api!.leafId!,
        direction: 'vertical'
      },
      {
        type: 'renamePane',
        workspace: WS,
        tabId: api!.tabId!,
        leafId: api!.leafId!,
        title: 'logs'
      },
      { type: 'setTabProps', workspace: WS, tabId: api!.tabId!, color: '#ff0000', isPinned: true },
      {
        type: 'splitGroup',
        workspace: WS,
        tabId: browser!.tabId!,
        besideGroupId: left,
        direction: 'right'
      }
    ],
    model
  )
  const apiSplit = arranged.results[0]!.leafId!
  const right = arranged.results[3]!.groupId!
  const moved = build(
    ctx,
    [{ type: 'moveTab', workspace: WS, tabId: chat!.tabId!, toGroupId: right, index: 1 }],
    arranged.model
  ).model
  const ws = moved.workspaces[WS]!
  const bound: WorkspaceLayoutModel = {
    ...moved,
    workspaces: {
      [WS]: {
        ...ws,
        leaves: {
          ...ws.leaves,
          [api!.leafId!]: { ...ws.leaves?.[api!.leafId!], ptyId: 'pty-1', incarnationId: 'inc-1' },
          [apiSplit]: { ptyId: 'pty-2' }
        }
      }
    }
  }
  return { model: bound, api, apiSplit, agent, readme, browser, chat, left, right }
}

function groupOf(model: WorkspaceLayoutModel, tabId: string): string {
  return model.workspaces[WS]!.groups.find((group) => group.tabOrder.includes(tabId))!.id
}

function views(fields: Partial<SessionTabsView> = {}): SessionTabsView {
  return { groups: {}, panes: {}, editorDrafts: {}, ...fields }
}

const noFacts: SessionTabsFacts = { tabLabels: {}, terminalRows: {}, browserTabs: {} }

describe('projectSessionTabs', () => {
  it("projects the model into today's snapshot rows, groups and selection", () => {
    const { model, api, apiSplit, agent, readme, browser, chat, left, right } = workspace()
    const apiTab = api!.tabId!
    const view = views({
      activeGroupIdByWorktree: { [WS]: left },
      groups: {
        [WS]: {
          [left]: { activeTabId: apiTab, recentTabIds: [agent!.tabId!, apiTab, 'gone'] },
          [right]: { activeTabId: chat!.tabId! }
        }
      },
      panes: { [apiTab]: { activeLeafId: apiSplit, expandedLeafId: null } },
      editorDrafts: { [WS]: { '/Users/dev/orca/README.md': { dirtyDraftContent: '# draft' } } }
    })
    const facts: SessionTabsFacts = {
      tabLabels: {},
      terminalRows: { [agent!.tabId!]: { title: 'Claude Code' } },
      browserTabs: {
        [WS]: {
          [browser!.tabId!]: {
            ...BLANK_BROWSER_TAB_STATE,
            activePageId: 'page-live',
            url: 'https://example.com',
            title: 'Example'
          }
        }
      }
    }
    const parentLayout = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: api!.leafId! },
        second: { type: 'leaf', leafId: apiSplit }
      },
      activeLeafId: apiSplit,
      expandedLeafId: null,
      ptyIdsByLeafId: { [api!.leafId!]: 'pty-1', [apiSplit]: 'pty-2' },
      titlesByLeafId: { [api!.leafId!]: 'logs' }
    } as const
    const expected: Omit<RuntimeMobileSessionTabsSnapshot, 'publicationEpoch' | 'snapshotVersion'> =
      {
        worktree: WS,
        activeGroupId: left,
        activeTabId: `${apiTab}::${apiSplit}`,
        activeTabType: 'terminal',
        tabGroups: [
          {
            id: left,
            activeTabId: apiTab,
            tabOrder: [apiTab, agent!.tabId!, readme!.tabId!],
            recentTabIds: [agent!.tabId!, apiTab]
          },
          {
            id: right,
            activeTabId: 'agent-session:session-1',
            tabOrder: [browser!.tabId!, 'agent-session:session-1'],
            recentTabIds: []
          }
        ],
        tabGroupLayout: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: left },
          second: { type: 'leaf', groupId: right }
        },
        tabs: [
          {
            type: 'terminal',
            id: `${apiTab}::${api!.leafId!}`,
            title: 'logs',
            parentTabId: apiTab,
            leafId: api!.leafId!,
            ptyId: 'pty-1',
            incarnationId: 'inc-1',
            parentLayout,
            color: '#ff0000',
            isPinned: true,
            isActive: false
          },
          {
            type: 'terminal',
            id: `${apiTab}::${apiSplit}`,
            title: 'api server',
            parentTabId: apiTab,
            leafId: apiSplit,
            ptyId: 'pty-2',
            parentLayout,
            color: '#ff0000',
            isPinned: true,
            isActive: true
          },
          {
            type: 'terminal',
            id: `${agent!.tabId!}::${agent!.leafId!}`,
            title: 'Claude Code',
            parentTabId: agent!.tabId!,
            leafId: agent!.leafId!,
            launchAgent: 'claude',
            startupCwd: '/Users/dev/orca',
            parentLayout: {
              root: { type: 'leaf', leafId: agent!.leafId! },
              activeLeafId: agent!.leafId!,
              expandedLeafId: null
            },
            isActive: false
          },
          {
            type: 'markdown',
            id: readme!.tabId!,
            title: 'README.md',
            filePath: '/Users/dev/orca/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: true,
            isActive: false,
            sourceFileId: '/Users/dev/orca/README.md',
            sourceFilePath: '/Users/dev/orca/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'file:/Users/dev/orca/README.md',
            color: null,
            isPinned: false
          },
          {
            type: 'browser',
            id: browser!.tabId!,
            title: 'Example',
            browserWorkspaceId: browser!.tabId!,
            browserPageId: 'page-live',
            url: 'https://example.com',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            color: null,
            isPinned: false,
            isActive: false
          },
          {
            type: 'agent-session',
            id: 'agent-session:session-1',
            title: 'Codex Chat',
            sessionId: 'session-1',
            agent: 'codex',
            isActive: false
          }
        ]
      }
    expect(projectSessionTabs(WS, model.workspaces[WS]!, view, facts)).toEqual(expected)
  })

  it('reads the tab name before the live terminal title (#19582)', () => {
    const { model, agent } = workspace()
    const facts = { ...noFacts, terminalRows: { [agent!.tabId!]: { title: 'zsh' } } }
    const renamed = build(
      testContext(),
      [{ type: 'renameTab', workspace: WS, tabId: agent!.tabId!, kind: 'custom', title: 'deploy' }],
      model
    ).model
    const rows = projectSessionTabs(WS, renamed.workspaces[WS]!, views(), facts).tabs
    expect(rows.find((row) => row.id.startsWith(agent!.tabId!))?.title).toBe('deploy')
  })

  it('names nothing active when the view selects nothing, and keeps one group without a tree', () => {
    const ctx = testContext()
    const { model } = build(ctx, [{ type: 'createTerminalTab', workspace: WS }])
    const projected = projectSessionTabs(WS, model.workspaces[WS]!, views(), noFacts)
    expect(projected).toMatchObject({ activeGroupId: null, activeTabId: null, activeTabType: null })
    expect(projected.tabGroups).toHaveLength(1)
    expect(projected).not.toHaveProperty('tabGroupLayout')
    expect(projected.tabs[0]).toMatchObject({ title: 'Terminal 1', isActive: false })
  })

  it('round-trips every row id to the tab (and pane) it names', () => {
    const { model, api, apiSplit } = workspace()
    const ws = model.workspaces[WS]!
    for (const row of projectSessionTabs(WS, ws, views(), noFacts).tabs) {
      const target = resolveSessionTabRow(ws, row.id)
      expect(target, row.id).not.toBeNull()
      if (row.type === 'terminal') {
        expect(target).toEqual({
          tab: expect.objectContaining({ entityId: row.parentTabId }),
          leafId: row.leafId
        })
      }
    }
    expect(resolveSessionTabRow(ws, `${api!.tabId!}::${apiSplit}`)?.leafId).toBe(apiSplit)
    expect(resolveSessionTabRow(ws, `${api!.tabId!}::not-a-pane`)).toBeNull()
  })
})
