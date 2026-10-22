import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import type { MainSessionTabRows } from './main-session-tab-rows'
import { withMainTabOrder } from './main-session-tab-order'

const WT = 'repo::/wt'

function terminal(id: string, ptyId?: string): RuntimeMobileSessionTerminalTab {
  const [parentTabId = id, leafId = id] = id.split('::')
  return {
    type: 'terminal',
    id,
    title: id,
    parentTabId,
    leafId,
    isActive: false,
    ...(ptyId ? { ptyId } : {})
  }
}

function written(tabs: RuntimeMobileSessionTerminalTab[]): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WT,
    publicationEpoch: 'headless-hydrated:1',
    snapshotVersion: 3,
    activeGroupId: 'headless',
    activeTabId: tabs[0]?.id ?? null,
    activeTabType: 'terminal',
    tabGroups: [
      { id: 'headless', activeTabId: tabs[0]?.parentTabId ?? null, tabOrder: ['a', 'b', 'c'] }
    ],
    tabs
  }
}

/** Main's layout: `c` first in one group, `a` split off in a second; main lacks `b`, holds `d`. */
const MAIN: MainSessionTabRows = {
  worktree: WT,
  activeGroupId: 'left',
  activeTabId: 'c::1',
  activeTabType: 'terminal',
  tabGroups: [
    { id: 'left', activeTabId: 'c', tabOrder: ['c', 'd'] },
    { id: 'right', activeTabId: 'a', tabOrder: ['a'] }
  ],
  tabGroupLayout: {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', groupId: 'left' },
    second: { type: 'leaf', groupId: 'right' }
  },
  tabs: [terminal('c::1'), terminal('d::1'), terminal('a::1')]
}

describe("the row writer's order from main (layout-owner build)", () => {
  it("orders and groups the written rows as main's layout does, adding and dropping none", () => {
    const rows = [terminal('a::1', 'pty-new'), terminal('b::1'), terminal('c::1')]

    const ordered = withMainTabOrder(written(rows), MAIN)

    // `b`, in no group main holds, joins the written selection's group.
    expect(ordered.tabs.map((tab) => tab.id)).toEqual(['c::1', 'a::1', 'b::1'])
    expect(ordered.tabGroups?.map((group) => [group.id, group.tabOrder])).toEqual([
      ['left', ['c']],
      ['right', ['a', 'b']]
    ])
    expect(ordered.tabGroupLayout).toEqual(MAIN.tabGroupLayout)
  })

  it("keeps every fact a written row carries, its terminal id and the writer's selection", () => {
    const rows = [terminal('a::1', 'pty-new'), terminal('c::1')]

    const ordered = withMainTabOrder(written(rows), MAIN)

    expect(ordered.tabs.find((tab) => tab.id === 'a::1')).toEqual(rows[0])
    expect(ordered).toMatchObject({ activeTabId: 'a::1', activeGroupId: 'right' })
  })

  it("lists the rows in main's group order, keeping a rebuilt group's chat first", () => {
    const file: RuntimeMobileSessionSnapshotTab = {
      type: 'file',
      id: 'f1',
      title: 'a.ts',
      filePath: '/wt/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      isDirty: false,
      isActive: false
    }
    const chat: RuntimeMobileSessionSnapshotTab = {
      type: 'agent-session',
      id: 'chat',
      title: 'Claude',
      sessionId: 's1',
      agent: 'claude',
      isActive: false
    }
    const page: RuntimeMobileSessionSnapshotTab = {
      type: 'browser',
      id: 'b1',
      title: 'page',
      browserWorkspaceId: 'bw',
      browserPageId: null,
      url: 'about:blank',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: false
    }
    // A rebuild: terminals first, under a group id main lacks that lists the chat first.
    const write: RuntimeMobileSessionTabsSnapshot = {
      ...written([]),
      activeTabId: 'c::2',
      activeGroupId: 'rebuilt',
      tabGroups: [{ id: 'rebuilt', activeTabId: 'c', tabOrder: ['chat', 'c', 'f1', 'b1', 'a'] }],
      tabs: [terminal('c::1'), terminal('c::2'), terminal('a::1'), file, chat, page]
    }
    const main: MainSessionTabRows = {
      ...MAIN,
      tabGroups: [
        { id: 'left', activeTabId: 'c', tabOrder: ['c', 'd', 'f1'] },
        { id: 'right', activeTabId: 'a', tabOrder: ['a'] }
      ]
    }

    const ordered = withMainTabOrder(write, main)

    // The strays (chat, page) join the selection's group where the rebuild listed them.
    expect(ordered.tabGroups?.map((group) => [group.id, group.tabOrder])).toEqual([
      ['left', ['chat', 'c', 'f1', 'b1']],
      ['right', ['a']]
    ])
    expect(ordered.tabs.map((tab) => tab.id)).toEqual(['chat', 'c::1', 'c::2', 'f1', 'b1', 'a::1'])
    expect(ordered.activeGroupId).toBe('left')
  })

  it('leaves the rows as written when main lists no group', () => {
    const write = written([terminal('a::1')])

    expect(withMainTabOrder(write, { ...MAIN, tabGroups: undefined })).toBe(write)
  })
})
