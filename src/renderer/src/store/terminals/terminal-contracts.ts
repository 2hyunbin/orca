import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace-session-hydration-keys'
import type { HostSessionSlices } from '@/lib/workspace-session-host-split'

/** In-memory recovery claim consumed only after the resumed terminal hook becomes live. */
export type AutomaticAgentResumeClaim = {
  worktreeId: string
  launchAgent: TuiAgent
  providerSession: AgentProviderSessionMetadata
}

/** Agents whose panes restart in place onto a newly selected account. */
export type AccountRestartAgent = 'codex' | 'claude'

/** A live Codex pane still on the account it launched under, after the selection moved on. */
export type CodexStalePane = {
  previousAccountLabel: string
  nextAccountLabel: string
  /** Labels are display-only; account ids disambiguate equal labels and A→B→A collapse. */
  previousAccountId?: string | null
  nextAccountId?: string | null
  /** The user chose to keep the launch account against `nextAccount*`. */
  kept?: true
}

export type HydrateWorkspaceSessionOptions = {
  runtimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
  /** Rows parked for hosts that lost a contested workspace id; omitted leaves the store's copy. */
  contestedHostWorkspaceSessions?: HostSessionSlices
  /** Partition each restored session key was read from; omitted leaves the store's copy. */
  contestedPrimaryHostBySessionKey?: Record<string, ExecutionHostId>
} & WorkspaceSessionHydrationOptions
