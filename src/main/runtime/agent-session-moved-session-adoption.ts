// A chat session moved here from another host, entering this store's draft as one transaction.

import { isDeepStrictEqual } from 'node:util'
import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { setAgentSessionTabVisibility } from './agent-session-tab-table'

export type MovedAgentSession = {
  record: AgentSessionRecord
  /** Its chat tab on the source; reused only where this host already keeps a tab index. */
  tabId: string | null
  operations: readonly { operationKey: string; row: AgentSessionOperationRow }[]
}

/** Released and adjudicated by the source: no process anywhere holds it, so nothing reconciles it. */
export function movedAgentSessionRecord(record: AgentSessionRecord): AgentSessionRecord {
  return { ...record, lease: { ...record.lease, unreconciled: false } }
}

export function adoptMovedAgentSession(
  draft: AgentSessionStoreState,
  moved: MovedAgentSession
): void {
  const { sessionId } = moved.record
  if (draft.records.has(sessionId) || draft.unreadableRecords.has(sessionId)) {
    throw new Error(`orcad_migration_agent_session_conflict:${sessionId}:record`)
  }
  draft.records.set(sessionId, movedAgentSessionRecord(moved.record))
  for (const { operationKey, row } of moved.operations) {
    const existing = draft.operations.get(operationKey)
    if (existing && !isDeepStrictEqual(existing, row)) {
      throw new Error(`orcad_migration_agent_session_conflict:${sessionId}:operation`)
    }
    if (!existing) {
      draft.operations.set(operationKey, row)
    }
  }
  // Without an index a host restores chats from its profile tabs; starting one here would drop those.
  if (moved.tabId !== null && draft.sessionTabs !== null) {
    setAgentSessionTabVisibility(draft, sessionId, true, moved.tabId)
  }
}
