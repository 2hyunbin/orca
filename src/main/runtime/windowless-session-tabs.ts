// The session-tabs list a host with no window publishes: its saved layout, projected as a window
// would publish it, with each browser tab showing its page's live state. Built from the saved
// layout every time, so the list and the layout stream name the same groups, order and selection.

import type { ExecutionHostId } from '../../shared/execution-host'
import type { BrowserTabInfo } from '../../shared/runtime-browser-contracts'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { preserveTerminalRetirementProofs } from './mobile-session-terminal-retirement-proof'
import { headlessMobileSnapshotContentUnchanged } from './mobile-session-snapshot-equality'
import {
  projectSessionTabs,
  resolveSessionTabRow,
  type ProjectedSessionTabs
} from '../../shared/workspace-layout/old-client'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
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

/**
 * The snapshot to store for a projection: carrying the host's close proofs, versioned past the one
 * clients have; null when nothing changed, or nothing is listed and nothing ever was.
 */
export function nextWindowlessSnapshot(
  worktreeId: string,
  projected: ProjectedSessionTabs | null,
  existing: RuntimeMobileSessionTabsSnapshot | undefined
): RuntimeMobileSessionTabsSnapshot | null {
  if (!existing && !projected?.tabs.length) {
    return null
  }
  const next = preserveTerminalRetirementProofs(
    {
      ...(projected ?? {
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }),
      worktree: existing?.worktree ?? worktreeId,
      publicationEpoch: `headless-hydrated:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1
    },
    existing
  )
  return existing && headlessMobileSnapshotContentUnchanged(existing, next) ? null : next
}

/**
 * The partition with a listed row's tab shown in its group, and its group the active one, as a
 * window saves the tab a user selects. A terminal row also focuses its pane. Null when no saved
 * tab holds the row.
 */
export function withSavedTabSelection(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  rowId: string
): WorkspaceSessionState | null {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const workspace = loaded.layout.workspaces[worktreeId]
  const target = workspace ? resolveSessionTabRow(workspace, rowId) : null
  const group = target && workspace?.groups.find((entry) => entry.tabOrder.includes(target.tab.id))
  if (!target || !group) {
    return null
  }
  const { tab, leafId } = target
  const view = loaded.desktopView
  const groups = view.groups[worktreeId] ?? {}
  const recentTabIds = (groups[group.id]?.recentTabIds ?? []).filter((id) => id !== tab.id)
  view.groups = {
    ...view.groups,
    [worktreeId]: {
      ...groups,
      [group.id]: { activeTabId: tab.id, recentTabIds: [...recentTabIds, tab.id] }
    }
  }
  view.activeGroupIdByWorktree = { ...view.activeGroupIdByWorktree, [worktreeId]: group.id }
  if (tab.kind === 'terminal') {
    view.activeTabIdByWorktree = { ...view.activeTabIdByWorktree, [worktreeId]: tab.id }
    if (leafId) {
      view.panes = {
        ...view.panes,
        [tab.entityId]: {
          expandedLeafId: view.panes[tab.entityId]?.expandedLeafId ?? null,
          activeLeafId: leafId
        }
      }
    }
  }
  return saveWorkspaceLayout(loaded)
}

/**
 * Re-lists every listed worktree after each burst of saved-layout writes while no renderer is
 * attached, as the layout stream re-projects; a write never waits on it.
 */
export class WindowlessSessionTabsRepublisher {
  private scheduled = false

  constructor(
    private readonly deps: {
      isWindowless: () => boolean
      listedWorktreeIds: () => readonly string[]
      republish: (worktreeId: string) => void
    }
  ) {}

  written(): void {
    if (this.scheduled || !this.deps.isWindowless()) {
      return
    }
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.deps.isWindowless()) {
        return
      }
      for (const worktreeId of this.deps.listedWorktreeIds()) {
        try {
          this.deps.republish(worktreeId)
        } catch (error) {
          console.warn('[session-tabs] could not list a worktree from its saved layout:', error)
        }
      }
    })
  }
}
