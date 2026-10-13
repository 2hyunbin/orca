// A browser tab a host with no window runs, saved as a window saves its own: the tab, its page and
// the page's last address. A restarted host lists it and starts the page when something first
// uses it, as a window restores its browser tabs.

import type { BrowserPage } from '../../shared/browser-workspace-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { applyLayoutCommand } from '../../shared/workspace-layout/workspace-layout-commands'
import { BLANK_BROWSER_TAB_STATE } from '../../shared/workspace-layout/workspace-layout-beside'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import type { LoadedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { randomUUID } from 'node:crypto'

export type ServeBrowserPageState = {
  worktreeId: string
  pageId: string
  url: string
  title: string
}

/** The saved browser tab showing this page, and the page; a host's own tab is named by its page. */
export function findSavedBrowserPage(
  session: WorkspaceSessionState,
  worktreeId: string,
  pageId: string
): { tabId: string; page: BrowserPage } | null {
  for (const tab of session.browserTabsByWorktree?.[worktreeId] ?? []) {
    const page = session.browserPagesByWorkspace?.[tab.id]?.find((entry) => entry.id === pageId)
    if (page) {
      return { tabId: tab.id, page }
    }
  }
  return null
}

/** Writes the page's address over its saved page and its tab's copy of it, as a window does. */
function withPage(
  loaded: LoadedWorkspaceLayout,
  tabId: string,
  page: BrowserPage,
  state: ServeBrowserPageState
): void {
  const { facts } = loaded
  const live = { url: state.url, title: state.title }
  const tab = facts.browserTabs[state.worktreeId]?.[tabId]
  // The tab mirrors its active page only.
  if (!tab?.activePageId || tab.activePageId === page.id) {
    facts.browserTabs[state.worktreeId] = {
      ...facts.browserTabs[state.worktreeId],
      [tabId]: { ...BLANK_BROWSER_TAB_STATE, ...tab, ...live }
    }
  }
  const pages = facts.browserPagesByWorkspace?.[tabId] ?? []
  facts.browserPagesByWorkspace = {
    ...facts.browserPagesByWorkspace,
    [tabId]: pages.some((entry) => entry.id === page.id)
      ? pages.map((entry) => (entry.id === page.id ? { ...entry, ...live } : entry))
      : [...pages, { ...page, ...live }]
  }
}

/** The partition with a just-created page's tab, or null when the layout refuses it. */
export function withOpenedServeBrowserTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  page: ServeBrowserPageState & { profileId?: string | null; groupId?: string }
): WorkspaceSessionState | null {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const now = Date.now()
  const applied = applyLayoutCommand(
    loaded.layout,
    {
      type: 'openBrowserTab',
      workspace: page.worktreeId,
      pageId: page.pageId,
      ...(page.profileId ? { profileId: page.profileId } : {}),
      ...(page.groupId ? { groupId: page.groupId } : {})
    },
    { mintId: randomUUID, mintLeafId: randomUUID, now: () => now }
  )
  if (!applied.ok) {
    return null
  }
  const next = { ...loaded, layout: applied.model }
  withPage(
    next,
    page.pageId,
    {
      ...BLANK_BROWSER_TAB_STATE,
      id: page.pageId,
      workspaceId: page.pageId,
      worktreeId: page.worktreeId,
      url: page.url,
      title: page.title,
      createdAt: now
    },
    page
  )
  return saveWorkspaceLayout(next)
}

/** The partition with the page's last address, or null when no saved tab shows the page. */
export function withServeBrowserPageState(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  page: ServeBrowserPageState
): WorkspaceSessionState | null {
  const saved = findSavedBrowserPage(session, page.worktreeId, page.pageId)
  if (!saved || (saved.page.url === page.url && saved.page.title === page.title)) {
    return null
  }
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  withPage(loaded, saved.tabId, saved.page, page)
  return saveWorkspaceLayout(loaded)
}

/** The partition without the tab showing the page, or null when no saved tab shows it. */
export function withClosedServeBrowserTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  pageId: string
): WorkspaceSessionState | null {
  const saved = findSavedBrowserPage(session, worktreeId, pageId)
  if (!saved) {
    return null
  }
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const applied = applyLayoutCommand(
    loaded.layout,
    { type: 'closeTabs', workspace: worktreeId, tabIds: [saved.tabId], force: true },
    { mintId: randomUUID, mintLeafId: randomUUID, now: Date.now }
  )
  if (!applied.ok) {
    return null
  }
  const { [saved.tabId]: _closed, ...pages } = loaded.facts.browserPagesByWorkspace ?? {}
  return saveWorkspaceLayout({
    ...loaded,
    layout: applied.model,
    facts: { ...loaded.facts, browserPagesByWorkspace: pages }
  })
}
