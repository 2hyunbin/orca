// A layout-owner build's chat tab changes from this host (a chat it publishes, retires or restores):
// main's own layout commands, with or without a window, so main places a listed chat's tab.

import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { ChatTabChange } from './agent-session-tab-layout'
import type { WindowLayoutCommand } from './runtime-layout-apply'
import { savedSessionId } from './saved-structured-agent-session-restoration'

/**
 * The commands for `changes` against the workspace's stored tabs: a chat opens in the window's
 * active group unless a tab shows it, and a close drops the chat's tab. Main's open keeps a group
 * it lacks out, as a window's does.
 */
export function chatTabLayoutCommands(
  session: WorkspaceSessionState | null,
  worktreeId: string,
  changes: readonly ChatTabChange[]
): WindowLayoutCommand[] {
  const shown = new Map(
    (session?.unifiedTabs?.[worktreeId] ?? []).flatMap((tab) => {
      const sessionId = savedSessionId(tab)
      return sessionId ? [[sessionId, tab.id] as const] : []
    })
  )
  const activeGroupId = session?.activeGroupIdByWorktree?.[worktreeId] ?? undefined
  const commands: WindowLayoutCommand[] = []
  for (const change of changes) {
    if ('close' in change) {
      const tabId = shown.get(change.close)
      if (tabId) {
        shown.delete(change.close)
        commands.push({ type: 'closeTabs', workspace: worktreeId, tabIds: [tabId], force: true })
      }
      continue
    }
    const { sessionId, agent, tabId } = change.open
    if (shown.has(sessionId)) {
      continue
    }
    shown.set(sessionId, tabId)
    commands.push({
      type: 'openAgentSessionTab',
      workspace: worktreeId,
      tabId,
      sessionId,
      agent,
      ...(activeGroupId ? { groupId: activeGroupId } : {})
    })
  }
  return commands
}
