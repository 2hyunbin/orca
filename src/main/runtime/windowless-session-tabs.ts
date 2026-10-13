// The session-tabs list a host with no window publishes: its saved layout, projected as a window
// would publish it, plus what only runs live. Built from the saved layout every time, so the list
// and the layout stream name the same groups, order and selection.

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
import { firstGroupSeed } from '../../shared/workspace-layout/workspace-layout-load-order'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export type WindowlessSessionTabsInput = {
  hostId: ExecutionHostId
  session: WorkspaceSessionState
  worktreeId: string
  generatedTitlesEnabled: boolean
  /** Pages this host runs, by page id: a saved browser tab shows its page's live state. */
  livePages: ReadonlyMap<string, BrowserTabInfo>
  /** Pages a paired client runs for this host; the layout does not hold them. */
  clientPages: readonly RuntimeMobileSessionBrowserTab[]
}

/** Null when the worktree has nothing to list. */
export function projectWindowlessSessionTabs(
  input: WindowlessSessionTabsInput
): ProjectedSessionTabs | null {
  const { hostId, session, worktreeId } = input
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const workspace = loaded.layout.workspaces[worktreeId]
  const projected = workspace
    ? projectSessionTabs(
        worktreeId,
        workspace,
        loaded.desktopView,
        loaded.facts,
        input.generatedTitlesEnabled
      )
    : null
  const tabs = (projected?.tabs ?? []).map((tab) => withLivePage(tab, input.livePages))
  const listed = new Set(tabs.map((tab) => tab.id))
  const clientPages = input.clientPages.filter((page) => !listed.has(page.id))
  if (tabs.length + clientPages.length === 0) {
    return null
  }
  return withClientPages({ ...emptyProjection(worktreeId), ...projected, tabs }, clientPages)
}

function emptyProjection(worktreeId: string): ProjectedSessionTabs {
  return {
    worktree: worktreeId,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

function withLivePage(
  tab: RuntimeMobileSessionSnapshotTab,
  livePages: ReadonlyMap<string, BrowserTabInfo>
): RuntimeMobileSessionSnapshotTab {
  if (tab.type !== 'browser') {
    return tab
  }
  const live = tab.browserPageId ? livePages.get(tab.browserPageId) : undefined
  if (!live) {
    return tab
  }
  return {
    ...tab,
    title: live.title || live.url || tab.title,
    url: live.url || tab.url,
    loadError: live.loadError ?? undefined,
    certificateFailure: live.certificateFailure ?? undefined
  }
}

/** A client's page joins the end of the active group, or the group the Loader would mint. */
function withClientPages(
  projected: ProjectedSessionTabs,
  pages: readonly RuntimeMobileSessionBrowserTab[]
): ProjectedSessionTabs {
  if (pages.length === 0) {
    return projected
  }
  const ids = pages.map((page) => page.id)
  const groups = projected.tabGroups ?? []
  const target = groups.find((group) => group.id === projected.activeGroupId) ?? groups[0]
  const tabGroups = target
    ? groups.map((group) =>
        group.id === target.id ? { ...group, tabOrder: [...group.tabOrder, ...ids] } : group
      )
    : [
        {
          id: nameBasedLoadContext().mintId(firstGroupSeed(projected.worktree)),
          activeTabId: ids[0]!,
          tabOrder: ids
        }
      ]
  return {
    ...projected,
    activeGroupId: projected.activeGroupId ?? tabGroups[0]!.id,
    tabGroups,
    tabs: [...projected.tabs, ...pages]
  }
}
