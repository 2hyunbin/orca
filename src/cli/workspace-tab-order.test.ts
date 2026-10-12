import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../shared/runtime-types'
import { projectWorkspaceTabRows } from './workspace-tab-rows'

const SNAPSHOT: RuntimeMobileSessionTabsResult = {
  worktree: 'folder-workspace',
  publicationEpoch: 'epoch',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: [
    {
      type: 'file',
      id: 'file',
      title: 'First in array',
      filePath: 'C:\\project\\app.ts',
      relativePath: 'app.ts',
      language: 'typescript',
      isDirty: false,
      isActive: false
    },
    {
      type: 'terminal',
      id: 'pane-a',
      parentTabId: 'split',
      leafId: 'a',
      title: 'Shell',
      status: 'ready',
      terminal: 'term_a',
      isActive: false
    },
    {
      type: 'agent-session',
      id: 'chat',
      sessionId: 's',
      agent: 'codex',
      title: 'Last in strip',
      isActive: false
    },
    {
      type: 'terminal',
      id: 'pane-b',
      parentTabId: 'split',
      leafId: 'b',
      title: 'Shell',
      status: 'ready',
      terminal: 'term_b',
      isActive: true
    }
  ],
  tabGroups: [
    { id: 'right', activeTabId: 'chat', tabOrder: ['file', 'chat'] },
    { id: 'left', activeTabId: 'split', tabOrder: ['split'] }
  ],
  tabGroupLayout: {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', groupId: 'left' },
    second: { type: 'leaf', groupId: 'right' }
  }
}

describe('workspace tab group ordering', () => {
  it('follows the split group layout and tab order while retaining both terminal panes', () => {
    const rows = projectWorkspaceTabRows(SNAPSHOT)
    expect(rows.map((row) => row.tabId)).toEqual(['split', 'file', 'chat'])
    expect(rows[0]).toMatchObject({ terminals: ['term_a', 'term_b'], active: true })
    expect(SNAPSHOT.tabs.map((tab) => tab.id)).toEqual(['file', 'pane-a', 'chat', 'pane-b'])
  })

  it('uses complete supplied group order when there is no layout', () => {
    const rows = projectWorkspaceTabRows({ ...SNAPSHOT, tabGroupLayout: null })
    expect(rows.map((row) => row.tabId)).toEqual(['file', 'chat', 'split'])
  })

  it('ignores group ids for kinds omitted by the host without dropping returned rows', () => {
    const rows = projectWorkspaceTabRows({
      ...SNAPSHOT,
      tabGroups: [
        { id: 'left', activeTabId: 'split', tabOrder: ['omitted-editor', 'split'] },
        { id: 'right', activeTabId: 'chat', tabOrder: ['chat', 'file'] }
      ]
    })
    expect(rows.map((row) => row.tabId)).toEqual(['split', 'chat', 'file'])
    expect(rows[0]?.terminals).toEqual(['term_a', 'term_b'])
  })

  it.each<Partial<RuntimeMobileSessionTabsResult>>([
    { tabGroups: undefined, tabGroupLayout: null },
    {
      tabGroups: [{ id: 'left', activeTabId: null, tabOrder: ['split', 'chat'] }],
      tabGroupLayout: null
    },
    {
      tabGroups: [{ id: 'g', activeTabId: null, tabOrder: ['chat', 'split', 'split', 'file'] }],
      tabGroupLayout: null
    },
    {
      tabGroups: [
        { id: 'g', activeTabId: null, tabOrder: ['chat', 'split'] },
        { id: 'g', activeTabId: null, tabOrder: ['file'] }
      ],
      tabGroupLayout: null
    },
    { tabGroupLayout: { type: 'leaf', groupId: 'left' } },
    {
      tabGroupLayout: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', groupId: 'left' },
        second: { type: 'leaf', groupId: 'unknown' }
      }
    }
  ])(
    'preserves array order and all split handles for incomplete or inconsistent metadata: %j',
    (metadata) => {
      const rows = projectWorkspaceTabRows({ ...SNAPSHOT, ...metadata })
      expect(rows.map((row) => row.tabId)).toEqual(['file', 'split', 'chat'])
      expect(rows[1]).toMatchObject({ terminals: ['term_a', 'term_b'], active: true })
    }
  )
})
