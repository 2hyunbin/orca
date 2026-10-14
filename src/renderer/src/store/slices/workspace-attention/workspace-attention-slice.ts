import type { StateCreator } from 'zustand'
import type { AgentAttentionUnreadReason } from '@/attention/agent-attention-contract'
import type { AppState } from '../../types'
import type { WorkspaceAttentionSlice } from './workspace-attention-contract'
import { clearWorkspaceUnreadFlag, markWorkspaceUnreadFlag } from './workspace-unread-flag'

export const createWorkspaceAttentionSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspaceAttentionSlice
> = (set, get) => {
  const markTabUnread = (tabId: string, reason: AgentAttentionUnreadReason): void => {
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
    set((s) =>
      s.unreadTerminalTabs[tabId]
        ? s
        : { unreadTerminalTabs: { ...s.unreadTerminalTabs, [tabId]: reason } }
    )
  }
  const markPaneUnread = (paneKey: string, reason: AgentAttentionUnreadReason): void => {
    set((s) =>
      s.unreadTerminalPanes[paneKey]
        ? s
        : { unreadTerminalPanes: { ...s.unreadTerminalPanes, [paneKey]: reason } }
    )
  }
  const markCompletionUnread = (paneKey: string, reason: AgentAttentionUnreadReason): void => {
    set((s) =>
      s.unreadAgentCompletionPanes[paneKey]
        ? s
        : { unreadAgentCompletionPanes: { ...s.unreadAgentCompletionPanes, [paneKey]: reason } }
    )
  }
  const clearTabUnread = (tabId: string): void => {
    set((s) => {
      if (!s.unreadTerminalTabs[tabId]) {
        return s
      }
      const copy = { ...s.unreadTerminalTabs }
      delete copy[tabId]
      return { unreadTerminalTabs: copy }
    })
  }
  const clearPaneUnread = (paneKey: string): void => {
    set((s) => {
      if (!s.unreadTerminalPanes[paneKey] && !s.unreadAgentCompletionPanes[paneKey]) {
        return s
      }
      const unreadTerminalPanes = { ...s.unreadTerminalPanes }
      const unreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
      delete unreadTerminalPanes[paneKey]
      delete unreadAgentCompletionPanes[paneKey]
      return { unreadTerminalPanes, unreadAgentCompletionPanes }
    })
  }
  const paneAttentionEnabled = (): boolean => get().settings?.experimentalTerminalAttention === true

  return {
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    markTerminalBell: ({ worktreeId, tabId, paneKey }) => {
      // Why: a bell is authoritative PTY output, so it marks even the pane the user is watching.
      markWorkspaceUnreadFlag(set, get, worktreeId)
      markTabUnread(tabId, 'terminal-bell')
      if (paneAttentionEnabled()) {
        markPaneUnread(paneKey, 'terminal-bell')
      }
    },
    markAgentAttentionUnread: ({ workspaceId, subjectKey, groupId, reason }) => {
      markWorkspaceUnreadFlag(set, get, workspaceId)
      if (subjectKey === null) {
        return
      }
      // Why: focus-return auto-ack needs an agent-specific marker; the tab and pane markers
      // below also cover bells and are gated behind the experimental attention setting.
      markCompletionUnread(subjectKey, reason)
      if (groupId !== null && paneAttentionEnabled()) {
        markTabUnread(groupId, reason)
        markPaneUnread(subjectKey, reason)
      }
    },
    readTerminalPaneOnInput: ({ worktreeId, tabId, paneKey }) => {
      clearTabUnread(tabId)
      if (paneKey !== null) {
        clearPaneUnread(paneKey)
      }
      clearWorkspaceUnreadFlag(set, get, worktreeId)
    },
    readViewedAgentAttention: ({ workspaceIdToClear, groupId, subjectKeys }) => {
      if (workspaceIdToClear !== null) {
        clearWorkspaceUnreadFlag(set, get, workspaceIdToClear)
      }
      clearTabUnread(groupId)
      for (const subjectKey of subjectKeys) {
        clearPaneUnread(subjectKey)
      }
    },
    setWorkspaceUnreadByUser: (worktreeId, isUnread, executionHostId) => {
      // Why: a manual toggle is host-scoped, unlike engagement which reads every row with the id.
      void get().updateWorktreeMeta(worktreeId, { isUnread }, { executionHostId })
    }
  }
}
