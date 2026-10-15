// The hook server's current row for the agent in a terminal: the one store of agent status
// (`AGENTS.md`), read for this exact pane, host connection and launch.

import type { AgentStatusIpcPayload, AgentType } from '../../shared/agent-status-types'
import { terminalHostConnectionMatches } from './orchestration/worker-provider-session'

export type TerminalHookRow = Pick<
  AgentStatusIpcPayload,
  | 'paneKey'
  | 'worktreeId'
  | 'agentType'
  | 'providerSession'
  | 'receivedAt'
  | 'connectionId'
  | 'launchToken'
  | 'turnStartedAt'
  | 'mainAgent'
>

export type TerminalHookRowDeps = {
  getHandleRecord: (
    handle: string
  ) => { worktreeId: string; tabId: string; ptyId: string | null } | undefined
  getPtyAgents: (ptyId: string) =>
    | {
        launchAgent?: AgentType | null
        foregroundAgent?: AgentType | null
        connectionId?: string | null
        wslDistro?: string | null
        launchToken?: string | null
      }
    | undefined
  getTerminalPaneKey: (handle: string) => string | null
  getAgentStatusSnapshotForPane: (paneKey: string) => readonly TerminalHookRow[]
}

export function currentTerminalHookRow(
  deps: TerminalHookRowDeps,
  handle: string
): TerminalHookRow | undefined {
  const record = deps.getHandleRecord(handle)
  const paneKey = record ? deps.getTerminalPaneKey(handle) : null
  if (!record || !paneKey) {
    return undefined
  }
  const pty = record.ptyId ? deps.getPtyAgents(record.ptyId) : undefined
  return deps
    .getAgentStatusSnapshotForPane(paneKey)
    .filter(
      (row) =>
        row.paneKey === paneKey &&
        (!row.worktreeId || row.worktreeId === record.worktreeId) &&
        terminalHostConnectionMatches(row.connectionId, pty?.connectionId, pty?.wslDistro) &&
        (!pty?.launchToken || row.launchToken === pty.launchToken)
    )
    .sort((left, right) => right.receivedAt - left.receivedAt)[0]
}
