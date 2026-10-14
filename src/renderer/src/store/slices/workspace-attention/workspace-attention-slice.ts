import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import {
  applyAgentAttentionUnread,
  applyTerminalBell,
  clearPaneAttention,
  clearTabAttention,
  createWorkspaceAttentionWriters
} from './subject-attention-marks'
import type { WorkspaceAttentionSlice } from './workspace-attention-contract'
import { clearWorkspaceUnreadFlag } from './workspace-unread-flag'

export const createWorkspaceAttentionSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspaceAttentionSlice
> = (set, get) => {
  const writers = createWorkspaceAttentionWriters(set, get)
  return {
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    markTerminalBell: (target) => {
      // Why: a bell is authoritative PTY output, so it marks even the pane the user is watching.
      applyTerminalBell(target, get().settings?.experimentalTerminalAttention === true, writers)
    },
    markAgentAttentionUnread: (write) => applyAgentAttentionUnread(write, writers),
    readTerminalPaneOnInput: ({ worktreeId, tabId, paneKey }) => {
      clearTabAttention(set, tabId)
      if (paneKey !== null) {
        clearPaneAttention(set, paneKey)
      }
      clearWorkspaceUnreadFlag(set, get, worktreeId)
    },
    readViewedAgentAttention: ({ workspaceIdToClear, groupId, subjectKeys }) => {
      if (workspaceIdToClear !== null) {
        clearWorkspaceUnreadFlag(set, get, workspaceIdToClear)
      }
      clearTabAttention(set, groupId)
      for (const subjectKey of subjectKeys) {
        clearPaneAttention(set, subjectKey)
      }
    },
    setWorkspaceUnreadByUser: (worktreeId, isUnread, executionHostId) => {
      // Why: a manual toggle is host-scoped, unlike engagement which reads every row with the id.
      void get().updateWorktreeMeta(worktreeId, { isUnread }, { executionHostId })
    }
  }
}
