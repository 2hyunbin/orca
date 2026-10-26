// A conversation's turn is named by the host's stamp on its agent's hook row, wherever that stamp exists.
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { hookRowAgentPhase } from '../../shared/agent-transitions'
import { mainAgentState } from '../../shared/main-agent-status'

/**
 * The turn a cancel may name: this host's own stamp while its agent works or waits on the user. A row
 * relayed from another host, replayed or restored can carry an earlier turn's stamp, so it proves none.
 */
export function provableOpenTurn(row: AgentStatusIpcPayload | null): number | null {
  if (
    !row ||
    row.turnStartedAt === undefined ||
    row.connectionId !== null ||
    row.isReplay ||
    row.restoredUnconfirmed
  ) {
    return null
  }
  // The main agent's, as interrupts read it: background agents or shells can keep the row busy after its turn.
  const state = mainAgentState(row)
  return state === 'working' || state === 'waiting' || state === 'blocked'
    ? row.turnStartedAt
    : null
}

/**
 * The stamped turn a working row shows, however it got there: prompt news, a new prompt after a dismissed
 * approval, or a stamp landing on a row already working. Null for other rows.
 */
export function workingStampedTurn(row: AgentStatusIpcPayload | null): number | null {
  if (!row || row.structuredHost || hookRowAgentPhase(row) !== 'working') {
    return null
  }
  return row.turnStartedAt ?? null
}
