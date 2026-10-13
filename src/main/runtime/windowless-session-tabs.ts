// The session-tabs list a host with no window publishes: its saved layout, projected as a window
// would publish it, with each browser tab showing its page's live state. Built from the saved
// layout every time, so the list and the layout stream name the same groups, order and selection.

import type { ExecutionHostId } from '../../shared/execution-host'
import type { BrowserTabInfo } from '../../shared/runtime-browser-contracts'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab
} from '../../shared/runtime-types'
import {
  projectSessionTabs,
  type ProjectedSessionTabs
} from '../../shared/workspace-layout/old-client'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export type WindowlessSessionTabsInput = {
  hostId: ExecutionHostId
  session: WorkspaceSessionState
  worktreeId: string
  generatedTitlesEnabled: boolean
  /** Pages this host runs, by page id. */
  hostPages: ReadonlyMap<string, BrowserTabInfo>
  /** Pages paired clients run for this host, by page id, as their rows publish them. */
  clientPages: ReadonlyMap<string, RuntimeMobileSessionBrowserTab>
}

/** Null when the worktree has no saved layout. */
export function projectWindowlessSessionTabs(
  input: WindowlessSessionTabsInput
): ProjectedSessionTabs | null {
  const { hostId, session, worktreeId } = input
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const workspace = loaded.layout.workspaces[worktreeId]
  if (!workspace) {
    return null
  }
  const projected = projectSessionTabs(
    worktreeId,
    workspace,
    loaded.desktopView,
    loaded.facts,
    input.generatedTitlesEnabled
  )
  return { ...projected, tabs: projected.tabs.map((tab) => withLivePage(tab, input)) }
}

function withLivePage(
  tab: RuntimeMobileSessionSnapshotTab,
  input: WindowlessSessionTabsInput
): RuntimeMobileSessionSnapshotTab {
  if (tab.type !== 'browser' || !tab.browserPageId) {
    return tab
  }
  const clientPage = input.clientPages.get(tab.browserPageId)
  if (clientPage) {
    // The client's row says where the page runs and how; the layout says where the tab sits.
    return {
      ...clientPage,
      id: tab.id,
      color: tab.color,
      isPinned: tab.isPinned,
      isActive: tab.isActive
    }
  }
  const hostPage = input.hostPages.get(tab.browserPageId)
  if (!hostPage) {
    return tab
  }
  return {
    ...tab,
    title: hostPage.title || hostPage.url || tab.title,
    url: hostPage.url || tab.url,
    loadError: hostPage.loadError ?? undefined,
    certificateFailure: hostPage.certificateFailure ?? undefined
  }
}
