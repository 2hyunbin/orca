// A chat tab a host with no window shows, saved in its layout as a window saves its own, so the
// layout is a complete record of the host's tabs.

import type { AgentType } from '../../shared/agent-status-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { applyLayoutCommand } from '../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { randomUUID } from 'node:crypto'

/** The partition with a tab for the chat in the active group; null when a saved tab shows it. */
export function withOpenedAgentSessionTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  chat: { sessionId: string; agent: AgentType }
): WorkspaceSessionState | null {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  if (savedAgentSessionTabId(loaded.layout.workspaces[worktreeId], chat.sessionId)) {
    return null
  }
  const groupId = loaded.desktopView.activeGroupIdByWorktree?.[worktreeId]
  const applied = applyLayoutCommand(
    loaded.layout,
    {
      type: 'openAgentSessionTab',
      workspace: worktreeId,
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
