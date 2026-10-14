import type { StateCreator } from 'zustand'
import type {
  AgentAttentionUnreadReason,
  StoredAgentAttentionUnread
} from '@/attention/agent-attention-contract'
import type { AgentAttentionUnreadWrite } from '@/attention/agent-attention-policy'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { AppState } from '../../types'

export type WorkspaceAttentionSet = Parameters<StateCreator<AppState>>[0]
export type WorkspaceAttentionGet = Parameters<StateCreator<AppState>>[1]

export type TerminalPaneAttentionTarget = {
  worktreeId: string
  tabId: string
  paneKey: string
}

/** The primitive writes every attention event composes; tests may substitute spies. */
export type WorkspaceAttentionWriters = {
  markWorkspaceUnread: (worktreeId: string) => void
  markTabUnread: (tabId: string, reason: AgentAttentionUnreadReason) => void
  markPaneUnread: (paneKey: string, reason: AgentAttentionUnreadReason) => void
  markCompletionUnread: (paneKey: string, reason: AgentAttentionUnreadReason) => void
}

/**
 * The unread records and every transition on them, named by the event that triggers it. The
 * persisted workspace flag `isUnread` lives on worktree/folder rows but only this module writes
 * it from the renderer. Removals and tab activation that happen inside
 * another slice's `set()` (close, sleep, purge, …) use the pure functions in
 * `subject-attention-transitions.ts` instead.
 */
export type WorkspaceAttentionSlice = {
  /** Tab marker, keyed by terminal tab id or a structured chat's unified tab id. Renderer-local. */
  unreadTerminalTabs: Record<string, StoredAgentAttentionUnread>
  /** Experimental per-pane marker (bells and completions), keyed by pane key. Renderer-local. */
  unreadTerminalPanes: Record<string, StoredAgentAttentionUnread>
  /** Agent completion awaiting acknowledgement, keyed by pane key. Renderer-local. */
  unreadAgentCompletionPanes: Record<string, StoredAgentAttentionUnread>
  /** A BEL arrived from a pane's PTY, mounted or parked. */
  markTerminalBell: (target: TerminalPaneAttentionTarget) => void
  /** An admitted, unviewed agent completion or prompt (terminal or structured chat). */
  markAgentAttentionUnread: (write: AgentAttentionUnreadWrite) => void
  /** Real input in a pane: a producing keydown, or a pointerdown (`paneKey` null when no leaf was hit). */
  readTerminalPaneOnInput: (target: {
    worktreeId: string
    tabId: string
    paneKey: string | null
  }) => void
  /** Auto-ack of the agent on screen; `workspaceIdToClear` is null while a hidden sibling is still unread. */
  readViewedAgentAttention: (args: {
    workspaceIdToClear: string | null
    groupId: string
    subjectKeys: Iterable<string>
  }) => void
  /** Sidebar "Mark as read" / "Mark as unread" on one host's row. */
  setWorkspaceUnreadByUser: (
    worktreeId: string,
    isUnread: boolean,
    executionHostId: ExecutionHostId
  ) => void
}
