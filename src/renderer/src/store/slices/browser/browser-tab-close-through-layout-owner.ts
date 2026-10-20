// A browser tab close in a layout-owner build: main closes the tab-bar entry and its record first,
// and its frame drops both. The window then runs today's close over the tab as it drew it (the
// reopen list, host pages, document grants), since the frame already took the record away.

import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import { dedupeTabOrder } from '../../../../../shared/workspace-layout/tab-order'
import type { AppState } from '../../types'
import { pickNextActiveTab } from '../tab-group-state'
import { closeContentTabThroughLayoutOwner } from '../tabs/content-tab-close-through-layout-owner'
import type { BrowserSliceGet, RemoteBrowserPageHandle } from './browser-slice-contract'

/** A browser tab as the window drew it when it asked main to close it. */
export type DrawnBrowserTab = {
  worktreeId: string
  record: BrowserWorkspace
  pages: BrowserPage[]
  handles: Record<string, RemoteBrowserPageHandle>
  tabs: Tab[]
  groups: TabGroup[]
}

/** `state` with the tab back as drawn, for today's close to read; it returns none of these. */
export function withDrawnBrowserTab(state: AppState, drawn: DrawnBrowserTab): AppState {
  const { worktreeId, record } = drawn
  const records = state.browserTabsByWorktree[worktreeId] ?? []
  return {
    ...state,
    browserTabsByWorktree: {
      ...state.browserTabsByWorktree,
      [worktreeId]: records.some((tab) => tab.id === record.id) ? records : [...records, record]
    },
    browserPagesByWorkspace: {
      ...state.browserPagesByWorkspace,
      [record.id]: state.browserPagesByWorkspace[record.id] ?? drawn.pages
    },
    remoteBrowserPageHandlesByPageId: {
      ...drawn.handles,
      ...state.remoteBrowserPageHandlesByPageId
    },
    unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [worktreeId]: drawn.tabs },
    groupsByWorktree: { ...state.groupsByWorktree, [worktreeId]: drawn.groups }
  }
}

/**
 * Sends the close of the browser tab showing `browserTabId`; false when it shows in no tab-bar
 * entry or main is not asked (a paired server owns the workspace's layout): close it as today.
 * `closeHere` is today's close; given the drawn tab, it runs once main's frame dropped it.
 */
export function closeBrowserTabThroughLayoutOwner(
  get: BrowserSliceGet,
  browserTabId: string,
  reason: 'user' | 'cleanup',
  closeHere: (drawn?: DrawnBrowserTab) => void,
  landIfEmptied?: () => boolean
): boolean {
  const state = get()
  const entry = Object.values(state.unifiedTabsByWorktree)
    .flat()
    .find((tab) => tab.contentType === 'browser' && tab.entityId === browserTabId)
  const record = entry
    ? state.browserTabsByWorktree[entry.worktreeId]?.find((tab) => tab.id === browserTabId)
    : undefined
  if (!entry || !record) {
    return false
  }
  const pages = state.browserPagesByWorkspace[browserTabId] ?? []
  const drawn: DrawnBrowserTab = {
    worktreeId: entry.worktreeId,
    record,
    pages,
    handles: Object.fromEntries(
      pages.flatMap((page) => {
        const handle = state.remoteBrowserPageHandlesByPageId[page.id]
        return handle ? [[page.id, handle] as const] : []
      })
    ),
    tabs: state.unifiedTabsByWorktree[entry.worktreeId] ?? [],
    groups: state.groupsByWorktree[entry.worktreeId] ?? []
  }
  const group = drawn.groups.find((candidate) => candidate.id === entry.groupId)
  const nextActiveTabId =
    group?.activeTabId === entry.id
      ? pickNextActiveTab(dedupeTabOrder(group.tabOrder), group.recentTabIds, entry.id, drawn.tabs)
      : (group?.activeTabId ?? null)
  return closeContentTabThroughLayoutOwner(get, entry, {
    nextActiveTabId,
    recordClose: reason,
    closeHere: () => closeHere(),
    closed: () => closeHere(drawn),
    ...(landIfEmptied ? { landIfEmptied } : {})
  })
}
