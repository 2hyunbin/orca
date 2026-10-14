import type { StateCreator } from 'zustand'
import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import type { AgentAttentionUnreadWrite } from '@/attention/agent-attention-policy'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { AppState } from '../../types'

export type WorkspaceAttentionSet = Parameters<StateCreator<AppState>>[0]
export type WorkspaceAttentionGet = Parameters<StateCreator<AppState>>[1]

export type OnScreenAttentionTarget = { worktreeId: string | null; tabId: string }

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
  /**
   * The tabs on screen in a visible, focused window are read — every marker of each tab.
   * `settleFlags` also settles their workspaces' flags when the screen just arrived on them.
   */
  readOnScreenAttention: (
    targets: readonly OnScreenAttentionTarget[],
    options: { settleFlags: boolean }
  ) => void
  /** Sidebar "Mark as read" (also removes every marker in the workspace) / "Mark as unread". */
  setWorkspaceUnreadByUser: (
    worktreeId: string,
    isUnread: boolean,
    executionHostId: ExecutionHostId
  ) => void
}
