import type { TerminalLaunchResult } from './agent-session-resume'
import type { ExecutionHostId } from './execution-host'

export type RuntimeTerminalCreate = TerminalLaunchResult & {
  coldRestore?: { scrollback: string; cwd: string; cols?: number; rows?: number }
  handle: string
  /** Host-owned PTY incarnation used to fence remote identity observations. */
  incarnationId?: string | null
  tabId?: string
  paneKey?: string | null
  ptyId?: string | null
  worktreeId: string
  title: string | null
  executionHostId?: ExecutionHostId
  hostPlatform?: NodeJS.Platform
  surface?: 'background' | 'visible'
  warning?: string
  agentSessionDisposition?: 'created' | 'adopted'
  isReattach?: true
  /** Spawn process identity for host-internal ownership proof. */
  processId?: number
}
