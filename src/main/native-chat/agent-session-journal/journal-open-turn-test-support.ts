import type {
  AgentJournalItemIdentity,
  AgentJournalTurnItem
} from '../../../shared/agent-session-journal-types'

export const STARTED_AT = 1_800_000_000_000

export const turnIdentity = (turnId: string): AgentJournalItemIdentity => ({
  provider: 'codex',
  threadId: 'thread-1',
  turnId,
  ordinal: 0
})

export function turn(
  turnId: string,
  state: AgentJournalTurnItem['state'],
  outcome?: AgentJournalTurnItem['outcome']
): AgentJournalTurnItem {
  return { kind: 'turn', turnId, state, startedAt: STARTED_AT, ...(outcome ? { outcome } : {}) }
}
