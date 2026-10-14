import type { AgentAttentionUnreadWrite } from '@/attention/agent-attention-policy'
import type {
  TerminalPaneAttentionTarget,
  WorkspaceAttentionGet,
  WorkspaceAttentionSet,
  WorkspaceAttentionWriters
} from './workspace-attention-contract'
import { markWorkspaceUnreadFlag } from './workspace-unread-flag'

// What each attention event marks. The writers are the only code that adds marker entries.

export function applyTerminalBell(
  target: TerminalPaneAttentionTarget,
  paneAttentionEnabled: boolean,
  writers: WorkspaceAttentionWriters
): void {
  writers.markWorkspaceUnread(target.worktreeId)
  writers.markTabUnread(target.tabId, 'terminal-bell')
  if (paneAttentionEnabled) {
    writers.markPaneUnread(target.paneKey, 'terminal-bell')
  }
}

export function applyAgentAttentionUnread(
  write: AgentAttentionUnreadWrite,
  writers: WorkspaceAttentionWriters
): void {
  writers.markWorkspaceUnread(write.workspaceId)
  if (write.subjectKey !== null) {
    // Why: focus-return auto-ack needs an agent-specific marker; the generic surface marker
    // below also covers bells and is gated behind the experimental attention setting.
    writers.markCompletionUnread(write.subjectKey, write.reason)
  }
  if (write.groupAttentionEnabled && write.groupId !== null && write.subjectKey !== null) {
    writers.markTabUnread(write.groupId, write.reason)
    writers.markPaneUnread(write.subjectKey, write.reason)
  }
}

export function createWorkspaceAttentionWriters(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet
): WorkspaceAttentionWriters {
  return {
    markWorkspaceUnread: (worktreeId) => markWorkspaceUnreadFlag(set, get, worktreeId),
    markTabUnread: (tabId, reason) => {
      const state = get()
      // Why both indexes: a container id is a terminal tab id, or a structured chat's unified tab
      // id (which has no TerminalTab record) — the same pair `findRenamableUnifiedTab` resolves,
      // and the same pair SortableTab reads this marker back under.
      const ownsTab =
        Object.values(state.tabsByWorktree ?? {})
          .flat()
          .some((tab) => tab.id === tabId) ||
        Object.values(state.unifiedTabsByWorktree ?? {})
          .flat()
          .some((tab) => tab.contentType === 'agent-session' && tab.id === tabId)
      if (!ownsTab) {
        return
      }
      // Why: terminal attention persists until real interaction.
      set((s) => {
        if (s.unreadTerminalTabs[tabId]) {
          return s
        }
        return { unreadTerminalTabs: { ...s.unreadTerminalTabs, [tabId]: reason } }
      })
    },
    markPaneUnread: (paneKey, reason) => {
      set((s) => {
        if (s.unreadTerminalPanes[paneKey]) {
          return s
        }
        return { unreadTerminalPanes: { ...s.unreadTerminalPanes, [paneKey]: reason } }
      })
    },
    markCompletionUnread: (paneKey, reason) => {
      set((s) => {
        if (s.unreadAgentCompletionPanes[paneKey]) {
          return s
        }
        return {
          unreadAgentCompletionPanes: {
            ...s.unreadAgentCompletionPanes,
            [paneKey]: reason
          }
        }
      })
    }
  }
}

export function clearTabAttention(set: WorkspaceAttentionSet, tabId: string): void {
  set((s) => {
    if (!s.unreadTerminalTabs[tabId]) {
      return s
    }
    const copy = { ...s.unreadTerminalTabs }
    delete copy[tabId]
    return { unreadTerminalTabs: copy }
  })
}

export function clearPaneAttention(set: WorkspaceAttentionSet, paneKey: string): void {
  set((s) => {
    if (!s.unreadTerminalPanes[paneKey] && !s.unreadAgentCompletionPanes[paneKey]) {
      return s
    }
    const nextUnreadTerminalPanes = { ...s.unreadTerminalPanes }
    const nextUnreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
    delete nextUnreadTerminalPanes[paneKey]
    delete nextUnreadAgentCompletionPanes[paneKey]
    return {
      unreadTerminalPanes: nextUnreadTerminalPanes,
      unreadAgentCompletionPanes: nextUnreadAgentCompletionPanes
    }
  })
}
