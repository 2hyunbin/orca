// The session-tabs list a host with no window publishes: its saved layout, projected as a window
// would publish it, with each browser tab showing its page's live state. Built from the saved
// layout every time, so the list and the layout stream name the same groups, order and selection.

import type { ExecutionHostId } from '../../shared/execution-host'
import type { BrowserTabInfo } from '../../shared/runtime-browser-contracts'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { preserveTerminalRetirementProofs } from './mobile-session-terminal-retirement-proof'
import { headlessMobileSnapshotContentUnchanged } from './mobile-session-snapshot-equality'
import {
  projectSessionTabs,
  resolveSessionTabRow,
  translateSessionTabMove,
  type ProjectedSessionTabs
} from '../../shared/workspace-layout/old-client'
import { applyLayoutCommand } from '../../shared/workspace-layout/workspace-layout-commands'
import { randomUUID } from 'node:crypto'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { AgentType } from '../../shared/agent-status-types'

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
 * The partition after a client's `session.tabs.move`, checked against the list it was shown, as a
 * window applies the same drag: the moved tab shows where it lands, and a group it left that was
 * showing it shows its first tab. Throws the move's refusal code.
 */
export function withMovedSessionTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  shown: ProjectedSessionTabs,
  move: RuntimeMobileSessionTabMove
): WorkspaceSessionState {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const workspace = loaded.layout.workspaces[worktreeId]
  if (!workspace) {
    throw new Error('tab_not_found')
  }
  const translation = translateSessionTabMove(worktreeId, workspace, shown, {
    ...move,
    worktree: worktreeId
  })
  if (!translation.ok) {
    throw new Error(translation.code)
  }
  const movedTabId = resolveSessionTabRow(workspace, move.tabId)!.tab.id
  const from = workspace.groups.find((group) => group.tabOrder.includes(movedTabId))
  // A window ignores a split of a group's only tab off that group.
  if (move.kind === 'split' && from?.id === move.targetGroupId && from.tabOrder.length === 1) {
    return session
  }
  const context = { mintId: randomUUID, mintLeafId: randomUUID, now: Date.now }
  let model = loaded.layout
  for (const command of translation.commands) {
    const applied = applyLayoutCommand(model, command, context)
    if (!applied.ok) {
      throw new Error(applied.code)
    }
    model = applied.model
  }
  const landed = model.workspaces[worktreeId]?.groups.find((group) =>
    group.tabOrder.includes(movedTabId)
  )
  if (landed?.id === from?.id) {
    // A reorder within a group keeps every selection.
    return saveWorkspaceLayout({ ...loaded, layout: model })
  }
  const groups = loaded.desktopView.groups[worktreeId] ?? {}
  const nextGroups: typeof groups = {}
  for (const group of model.workspaces[worktreeId]?.groups ?? []) {
    const shownTab = groups[group.id]?.activeTabId
    nextGroups[group.id] = {
      ...groups[group.id],
      activeTabId: group.tabOrder.includes(movedTabId)
        ? movedTabId
        : shownTab && group.tabOrder.includes(shownTab)
          ? shownTab
          : (group.tabOrder[0] ?? null)
    }
  }
  return saveWorkspaceLayout({
    ...loaded,
    layout: model,
    desktopView: {
      ...loaded.desktopView,
      groups: { ...loaded.desktopView.groups, [worktreeId]: nextGroups },
      ...(landed
        ? {
            activeGroupIdByWorktree: {
              ...loaded.desktopView.activeGroupIdByWorktree,
              [worktreeId]: landed.id
            }
          }
        : {})
    }
  })
}

/** The partition with a chat's tab saved in the active group; null when it is saved already. */
export function withOpenedAgentSessionTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  chat: { sessionId: string; agent: AgentType }
): WorkspaceSessionState | null {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const saved = loaded.layout.workspaces[worktreeId]?.tabs.some(
    (tab) => tab.kind === 'agent-session' && tab.entityId === chat.sessionId
  )
  if (saved) {
    return null
  }
  const applied = applyLayoutCommand(
    loaded.layout,
    { type: 'openAgentSessionTab', workspace: worktreeId, ...chat },
    { mintId: randomUUID, mintLeafId: randomUUID, now: Date.now }
  )
  return applied.ok ? saveWorkspaceLayout({ ...loaded, layout: applied.model }) : null
}

/** The partition without a chat's tab; null when no saved tab shows the chat. */
export function withClosedAgentSessionTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  sessionId: string
): WorkspaceSessionState | null {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const tab = loaded.layout.workspaces[worktreeId]?.tabs.find(
    (entry) => entry.kind === 'agent-session' && entry.entityId === sessionId
  )
  if (!tab) {
    return null
  }
  const applied = applyLayoutCommand(
    loaded.layout,
    { type: 'closeTabs', workspace: worktreeId, tabIds: [tab.id], force: true },
    { mintId: randomUUID, mintLeafId: randomUUID, now: Date.now }
  )
  return applied.ok ? saveWorkspaceLayout({ ...loaded, layout: applied.model }) : null
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
