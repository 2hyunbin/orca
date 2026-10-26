// A conversation's turn is named by the host's stamp on its agent's hook row, wherever that stamp exists.
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { hookRowAgentPhase } from '../../shared/agent-transitions'

/**
 * The host-stamped turn a row is in while its agent works or waits on the user; null when it rests or
 * the host stamps no turns. Only a stamped turn can be named by a cancel.
 */
export function openStampedTurn(row: AgentStatusIpcPayload | null): number | null {
  if (!row || row.turnStartedAt === undefined) {
    return null
  }
  const phase = hookRowAgentPhase(row)
  return phase === 'working' || phase === 'needs-you' ? row.turnStartedAt : null
}

/**
 * The stamped turn a move into working shows when no prompt-submitted news announced it, e.g. a new
 * prompt after a dismissed approval; null otherwise.
 */
export function unannouncedStampedStart(
  change: AgentPaneChange,
  row: AgentStatusIpcPayload | null
): number | null {
  if (
    change.kind !== 'moved' ||
    change.to !== 'working' ||
    change.transition === 'prompt-submitted'
  ) {
    return null
  }
  return row && !row.structuredHost ? (row.turnStartedAt ?? null) : null
}
