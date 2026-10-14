import type { StateCreator } from 'zustand'
import type { AgentAttentionUnreadReason } from '@/attention/agent-attention-contract'
import type { AppState } from '../../types'
import type { WorkspaceAttentionSlice } from './workspace-attention-contract'
import { collectRemovedAttention, dismissReadNotifications } from './attention-removal-follow-up'
import { removeTabsAttention } from './subject-attention-transitions'
import { markWorkspaceUnreadFlag, settleWorkspaceUnreadFlag } from './workspace-unread-flag'
import { workspaceMarkerTabIds } from './workspace-live-markers'
import { isTabOnScreen } from '@/hooks/agent-auto-ack-targets'

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
    // Why: a marker stays until its tab is read on screen, Marked as read, or closed.
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
  const removeMarkers = (tabIds: Iterable<string>): void => {
    set((s) => {
      const next = removeTabsAttention(s, tabIds)
      return next.unreadTerminalTabs === s.unreadTerminalTabs &&
        next.unreadTerminalPanes === s.unreadTerminalPanes &&
        next.unreadAgentCompletionPanes === s.unreadAgentCompletionPanes
        ? s
        : next
    })
  }
  const paneAttentionEnabled = (): boolean => get().settings?.experimentalTerminalAttention === true

  return {
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    markTerminalBell: ({ worktreeId, tabId, paneKey }) => {
      // Why: a bell on the tab on screen is already read; marking it would persist the flag
      // true then false, and a remote owner turns each persist into an RPC.
      if (isTabOnScreen(get(), worktreeId, tabId, 'terminal')) {
        return
      }
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
    readOnScreenAttention: (targets, { settleFlags }) => {
      const before = get()
      removeMarkers(targets.map((target) => target.tabId))
      const removed = collectRemovedAttention(before, get())
      // Why the targets' own workspaces: a tab id two workspaces share must settle the one on screen.
      // `settleFlags` also reads a flag with no marker behind it (Mark as unread, restart, another
      // client) when its workspace comes on screen, not on every later scan of the same screen.
      if (removed || settleFlags) {
        const { activeWorktreeId, activeWorkspaceExecutionHostId } = get()
        for (const { worktreeId } of targets) {
          if (worktreeId !== null) {
            settleWorkspaceUnreadFlag(
              set,
              get,
              worktreeId,
              worktreeId === activeWorktreeId ? activeWorkspaceExecutionHostId : null
            )
          }
        }
      }
      if (removed) {
        dismissReadNotifications(removed.paneKeys)
      }
    },
    setWorkspaceUnreadByUser: (worktreeId, isUnread, executionHostId) => {
      if (!isUnread) {
        const before = get()
        removeMarkers(workspaceMarkerTabIds(before, worktreeId))
        const removed = collectRemovedAttention(before, get())
        if (removed) {
          dismissReadNotifications(removed.paneKeys)
        }
      }
      // Why: a manual toggle is host-scoped, unlike reads, which settle every row with the id.
      void get().updateWorktreeMeta(worktreeId, { isUnread }, { executionHostId })
    }
  }
}
