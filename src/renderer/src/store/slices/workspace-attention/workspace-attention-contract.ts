import type { StateCreator } from 'zustand'
import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
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

/** The unread records and every transition on them; in-`set()` ones live in `subject-attention-transitions.ts`. */
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
