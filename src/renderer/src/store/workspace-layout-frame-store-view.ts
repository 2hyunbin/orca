// This window's view and content facts for some workspaces, read from the store's records the way
// the Loader reads them back from the window's save, so a workspace's frame slices build without
// serializing the window's session (design phase E2a). The save's own writers trim what it keeps
// (browser and scrollback state), so those run here too, over these workspaces' records only.

import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import {
  BROWSER_TAB_LAYOUT_FIELDS,
  BROWSER_TAB_WORKSPACE_FIELDS,
  type DesktopLayoutView,
  type LayoutContentFacts
} from '../../../shared/workspace-layout/workspace-layout-beside'
import {
  childRecord,
  omitStoredFields,
  pickStoredFields
} from '../../../shared/workspace-layout/stored-record-fields'
import { pruneLocalTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'
import {
  buildPersistedBrowserPagesByWorkspace,
  buildPersistedBrowserTabsByWorktree
} from '@/lib/workspace-session-browser-tabs'
import type { AppState } from './types'

export type LayoutFrameStoreViewState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'repos'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'localOnlyScrollbackByTabId'
  | 'browserTabsByWorktree'
  | 'browserPagesByWorkspace'
  | 'remoteBrowserPageHandlesByPageId'
  | 'activeTabIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeBrowserTabIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'markdownFrontmatterVisible'
>

function pickKeys<T>(map: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  return Object.fromEntries([...keys].flatMap((key) => (key in map ? [[key, map[key]!]] : [])))
}

function readPanes(
  tabId: string,
  layout: TerminalLayoutSnapshot,
  view: DesktopLayoutView,
  facts: LayoutContentFacts
): void {
  view.panes[tabId] = { activeLeafId: layout.activeLeafId, expandedLeafId: layout.expandedLeafId }
  for (const leafId of new Set([
    ...Object.keys(layout.buffersByLeafId ?? {}),
    ...Object.keys(layout.scrollbackRefsByLeafId ?? {})
  ])) {
    const buffer = layout.buffersByLeafId?.[leafId]
    const scrollbackRef = layout.scrollbackRefsByLeafId?.[leafId]
    facts.scrollback[leafId] = {
      ...(buffer !== undefined ? { buffer } : {}),
      ...(scrollbackRef !== undefined ? { scrollbackRef } : {})
    }
  }
}

/** The view and facts the frame slices of `keys` need; other workspaces' are left out. */
export function layoutViewAndFactsOfStore(
  state: LayoutFrameStoreViewState,
  keys: readonly string[]
): { view: DesktopLayoutView; facts: LayoutContentFacts } {
  // The builders read only these workspaces' entries of the selection maps.
  const view: DesktopLayoutView = {
    activeRepoId: state.activeRepoId,
    activeWorktreeId: state.activeWorktreeId,
    activeTabId: state.activeTabId,
    activeTabIdByWorktree: state.activeTabIdByWorktree,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    activeFileIdByWorktree: state.activeFileIdByWorktree,
    activeBrowserTabIdByWorktree: state.activeBrowserTabIdByWorktree,
    activeTabTypeByWorktree: state.activeTabTypeByWorktree,
    markdownFrontmatterVisible: state.markdownFrontmatterVisible,
    groups: {},
    lastFocusedAt: {},
    panes: {},
    editorDrafts: {}
  }
  const tabsByWorktree = pickKeys(state.tabsByWorktree, keys)
  const terminalTabIds = Object.values(tabsByWorktree).flatMap((rows) => rows.map((row) => row.id))
  const terminalLayoutsByTabId = pickKeys(state.terminalLayoutsByTabId, terminalTabIds)
  const localOnlyScrollbackByTabId = pickKeys(state.localOnlyScrollbackByTabId, terminalTabIds)
  // The save's scrollback trim reads only the rows and their pane trees.
  const terminals = pruneLocalTerminalScrollbackBuffers(
    { ...view, tabsByWorktree, terminalLayoutsByTabId, localOnlyScrollbackByTabId },
    state.repos
  )
  const browserTabs = buildPersistedBrowserTabsByWorktree(
    pickKeys(state.browserTabsByWorktree, keys)
  )
  const browserTabIds = Object.values(browserTabs ?? {}).flatMap((tabs) =>
    tabs.map((tab) => tab.id)
  )
  const facts: LayoutContentFacts = {
    localOnlyScrollbackByTabId: terminals.localOnlyScrollbackByTabId,
    browserPagesByWorkspace: buildPersistedBrowserPagesByWorkspace(
      pickKeys(state.browserPagesByWorkspace, browserTabIds),
      state.remoteBrowserPageHandlesByPageId
    ),
    tabLabels: {},
    terminalRows: {},
    scrollback: {},
    browserTabs: {}
  }
  for (const key of keys) {
    const entries = state.unifiedTabsByWorktree[key] ?? []
    const terminalEntries = new Map(
      entries.flatMap((entry) =>
        entry.contentType === 'terminal' ? [[entry.entityId, entry]] : []
      )
    )
    for (const entry of entries) {
      if (entry.contentType !== 'terminal') {
        childRecord(facts.tabLabels, key)[entry.id] = entry.label
      }
      if (entry.lastFocusedAt !== undefined) {
        childRecord(view.lastFocusedAt, key)[entry.id] = entry.lastFocusedAt
      }
    }
    for (const group of state.groupsByWorktree[key] ?? []) {
      childRecord(view.groups, key)[group.id] = {
        activeTabId: group.activeTabId,
        ...pickStoredFields(group, ['recentTabIds'])
      }
    }
    for (const row of tabsByWorktree[key] ?? []) {
      facts.terminalRows[row.id] = {
        title: terminalEntries.get(row.id)?.label ?? row.title,
        ...pickStoredFields(row, ['generation'])
      }
      const layout = terminals.terminalLayoutsByTabId[row.id]
      if (layout) {
        readPanes(row.id, layout, view, facts)
      }
    }
    for (const tab of browserTabs?.[key] ?? []) {
      childRecord(facts.browserTabs, key)[tab.id] = omitStoredFields(tab, [
        ...BROWSER_TAB_LAYOUT_FIELDS,
        ...BROWSER_TAB_WORKSPACE_FIELDS
      ])
    }
  }
  return { view, facts }
}
