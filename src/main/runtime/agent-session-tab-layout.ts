// A chat tab a host with no window shows, saved in its layout as a window saves its own, so the
// layout is a complete record of the host's tabs.

import type { AgentType } from '../../shared/agent-status-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { applyLayoutCommand } from '../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { randomUUID } from 'node:crypto'

/** The partition with a tab for the chat in the active group; null when a saved tab names it. */
export function withOpenedAgentSessionTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  chat: { sessionId: string; agent: AgentType; tabId: string }
): WorkspaceSessionState | null {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const workspace = loaded.layout.workspaces[worktreeId]
  const savedId = savedAgentSessionTabId(workspace, chat.sessionId)
  const saved = workspace?.tabs.find((tab) => tab.id === savedId)
  if (saved?.agentSessionAgent) {
    return null
  }
  if (workspace && saved) {
    // A tab saved before tabs named their agent is listed only once it does.
    const tabs = workspace.tabs.map((tab) =>
      tab === saved ? { ...tab, agentSessionAgent: chat.agent } : tab
    )
    const layout = {
      ...loaded.layout,
      workspaces: { ...loaded.layout.workspaces, [worktreeId]: { ...workspace, tabs } }
    }
    return saveWorkspaceLayout({ ...loaded, layout })
  }
  const groupId = loaded.desktopView.activeGroupIdByWorktree?.[worktreeId]
  const applied = applyLayoutCommand(
    loaded.layout,
    {
      type: 'openAgentSessionTab',
      workspace: worktreeId,
      tabId: chat.tabId,
      sessionId: chat.sessionId,
      agent: chat.agent,
      ...(groupId ? { groupId } : {})
    },
    { mintId: randomUUID, mintLeafId: randomUUID, now: Date.now }
  )
  return applied.ok ? saveWorkspaceLayout({ ...loaded, layout: applied.model }) : null
}

/** The partition without the chat's tab; null when no saved tab shows it. */
export function withClosedAgentSessionTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  sessionId: string
): WorkspaceSessionState | null {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const tabId = savedAgentSessionTabId(loaded.layout.workspaces[worktreeId], sessionId)
  if (!tabId) {
    return null
  }
  const applied = applyLayoutCommand(
    loaded.layout,
    { type: 'closeTabs', workspace: worktreeId, tabIds: [tabId], force: true },
    { mintId: randomUUID, mintLeafId: randomUUID, now: Date.now }
  )
  return applied.ok ? saveWorkspaceLayout({ ...loaded, layout: applied.model }) : null
}

function savedAgentSessionTabId(
  workspace: WorkspaceLayout | undefined,
  sessionId: string
): string | null {
  return (
    workspace?.tabs.find((tab) => tab.kind === 'agent-session' && tab.entityId === sessionId)?.id ??
    null
  )
}

export type SavedAgentSessionTab = { worktreeId: string; hostId: ExecutionHostId }

/**
 * This host's chats with a saved tab, by session, in every partition: a tab can be left in one
 * whose runtime id rotated (#18202). A tab stamped with another execution host is that host's chat,
 * listed in its index, not this one's.
 */
export function listSavedAgentSessionTabs(store: {
  getWorkspaceSessionHostIds?: () => ExecutionHostId[]
  getWorkspaceSession?: (hostId: ExecutionHostId) => WorkspaceSessionState | null | undefined
}): Map<string, SavedAgentSessionTab[]> {
  const saved = new Map<string, SavedAgentSessionTab[]>()
  for (const hostId of store.getWorkspaceSessionHostIds?.() ?? [LOCAL_EXECUTION_HOST_ID]) {
    const session = store.getWorkspaceSession?.(hostId)
    for (const [worktreeId, tabs] of Object.entries(session?.unifiedTabs ?? {})) {
      for (const tab of tabs) {
        const ownHost = !tab.executionHostId || tab.executionHostId === LOCAL_EXECUTION_HOST_ID
        if (tab.contentType === 'agent-session' && ownHost) {
          saved.set(tab.entityId, [...(saved.get(tab.entityId) ?? []), { worktreeId, hostId }])
        }
      }
    }
  }
  return saved
}
