import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import { withMainSessionTabRows, type MainSessionTabRows } from './main-session-tab-rows'

const WT = 'repo::/wt'

function terminal(
  id: string,
  extra: Partial<RuntimeMobileSessionTerminalTab> = {}
): RuntimeMobileSessionTerminalTab {
  return {
    type: 'terminal' as const,
    id,
    title: 'Terminal',
    parentTabId: id.split('::')[0]!,
    leafId: id.split('::')[1]!,
    isActive: false,
    ...extra
  }
}

function file(id: string, mode: 'edit' | 'diff' = 'edit') {
  return {
    type: 'file' as const,
    id,
    title: id,
    filePath: `/wt/${id}`,
    relativePath: id,
    language: 'typescript',
    mode,
    isDirty: false,
    isActive: false
  }
}

function browser(id: string) {
  return {
    type: 'browser' as const,
    id,
    title: 'Page',
    browserWorkspaceId: id,
    browserPageId: null,
    url: 'https://example.com',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }
}

function windowSnapshot(
  tabs: RuntimeMobileSessionSnapshotTab[],
  tabOrder: string[],
  activeTabId: string | null
): RuntimeMobileSessionTabsSnapshot {
  const active = tabs.find((tab) => tab.id === activeTabId)
  return {
    worktree: WT,
    publicationEpoch: 'renderer',
    snapshotVersion: 7,
    activeGroupId: 'g',
    activeTabId,
    activeTabType: active?.type ?? null,
    tabGroups: [{ id: 'g', activeTabId, tabOrder }],
    tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTabId }))
  }
}

function mainProjection(
  tabs: RuntimeMobileSessionSnapshotTab[],
  tabOrder: string[],
  activeTabId: string | null
): MainSessionTabRows {
  const {
    publicationEpoch: _e,
    snapshotVersion: _v,
    ...rest
  } = windowSnapshot(tabs, tabOrder, activeTabId)
  return rest
}

describe('session.tabs rows from main (layout-owner build, before D3b)', () => {
  it("takes main's terminal rows and name, with the window's theme, status and draft", () => {
    const theme = { mode: 'dark' as const, theme: {} }
    const agentStatus = null
    const merged = withMainSessionTabRows(
      windowSnapshot(
        [
          terminal('t::a', {
            title: 'Old',
            customTitle: 'Old',
            terminalTheme: theme,
            agentStatus,
            launchDraft: 'ls'
          })
        ],
        ['t'],
        't::a'
      ),
      mainProjection(
        [terminal('t::a', { title: 'Renamed', customTitle: 'Renamed' }), terminal('t::b')],
        ['t'],
        't::a'
      )
    )

    expect(merged.publicationEpoch).toBe('renderer')
    expect(merged.snapshotVersion).toBe(7)
    expect(merged.tabs).toEqual([
      terminal('t::a', {
        title: 'Renamed',
        customTitle: 'Renamed',
        terminalTheme: theme,
        agentStatus,
        launchDraft: 'ls',
        isActive: true
      }),
      terminal('t::b')
    ])
  })

  it('keeps the rows main does not hold (browser, diff) in the window’s place', () => {
    const merged = withMainSessionTabRows(
      windowSnapshot(
        [terminal('t::a'), browser('b1'), file('d1', 'diff'), file('f1')],
        ['t', 'b1', 'd1', 'f1'],
        't::a'
      ),
      mainProjection([terminal('t::a'), browser('b1'), file('f1')], ['t', 'b1', 'f1'], 't::a')
    )

    expect(merged.tabs.map((tab) => tab.id)).toEqual(['t::a', 'b1', 'd1', 'f1'])
    expect(merged.tabGroups?.[0]?.tabOrder).toEqual(['t', 'b1', 'd1', 'f1'])
  })

  // #30569: a closed editor leaves no stale active id behind.
  it('drops an editor main closed, and its stale active id, though the window still lists it', () => {
    const merged = withMainSessionTabRows(
      windowSnapshot([terminal('t::a'), file('f1')], ['t', 'f1'], 'f1'),
      mainProjection([terminal('t::a')], ['t'], 't::a')
    )

    expect(merged.tabs.map((tab) => tab.id)).toEqual(['t::a'])
    expect(merged).toMatchObject({ activeTabId: 't::a', activeTabType: 'terminal' })
    expect(merged.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(['t::a'])
    expect(merged.tabGroups?.[0]?.tabOrder).toEqual(['t'])
  })

  it("keeps the window's selection while it shows a row main does not list", () => {
    const merged = withMainSessionTabRows(
      windowSnapshot([terminal('t::a'), file('d1', 'diff')], ['t', 'd1'], 'd1'),
      mainProjection([terminal('t::a')], ['t'], 't::a')
    )

    expect(merged).toMatchObject({ activeTabId: 'd1', activeTabType: 'file' })
    expect(merged.tabGroups?.[0]?.activeTabId).toBe('d1')
    expect(merged.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(['d1'])
  })
})
