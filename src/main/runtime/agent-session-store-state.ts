import {
  agentSessionConversationView,
  type AgentSessionConversationView
} from '../../shared/agent-session-conversation-view'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
// The agent-session store's in-memory state: loaded from the chat journal database and written
// back to it row by row (agent-session-record-rows.ts).

import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionOrcaStopCause } from '../../shared/agent-session-orca-stop'
import type { AgentSessionTabTable } from './agent-session-tab-table'

export type RetiredAgentSessionClaimKey = { keyId: string; retiredAt: number }

export type AgentSessionStoreState = {
  records: Map<string, AgentSessionRecord>
  operations: Map<string, AgentSessionOperationRow>
  retiredClaimKeys: RetiredAgentSessionClaimKey[]
  /** Rows this build cannot validate, kept with a durable refusal reason. */
  unreadableRecords: Map<
    string,
    { reason: string; raw: unknown; conversation?: AgentSessionConversationView }
  >
  /** Chat tab id → the conversation it shows; null until this store first records a tab. */
  sessionTabs: AgentSessionTabTable | null
  /** How each earlier runtime recorded here ended: its quit or update, or a crash when it started
   *  and never ended; read once at load. A runtime it lacks, or null, attributes no death to Orca. */
  runtimeEnds?: ReadonlyMap<string, AgentSessionOrcaStopCause> | null
}

/** Every session id the state holds a row for, readable or not. */
export function heldAgentSessionIds(state: AgentSessionStoreState): string[] {
  return [...state.records.keys(), ...state.unreadableRecords.keys()]
}

export function getAgentSessionConversation(
  state: AgentSessionStoreState,
  id: string
): AgentSessionConversationView | null {
  const record = state.records.get(id)
  return record
    ? agentSessionConversationView(record)
    : (state.unreadableRecords.get(id)?.conversation ?? null)
}

export function listAgentSessionConversations(
  state: AgentSessionStoreState
): AgentSessionConversationView[] {
  return [...state.records.values()]
    .map(agentSessionConversationView)
    .concat(
      [...state.unreadableRecords.values()].flatMap((row) =>
        row.conversation ? [row.conversation] : []
      )
    )
}

/** The shared authority boundary for any fresh effect, distinct from conversation presence. */
export function requireWritableAgentSessionRecord(
  state: AgentSessionStoreState,
  id: string
): AgentSessionRecord {
  const record = state.records.get(id)
  if (record) {
    return record
  }
  throw state.unreadableRecords.has(id)
    ? agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' })
    : agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
}
