import type { JournalReducerState } from './journal-reducer'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'

/** Only original handover scope or an exact opener proves which turn received an input. */
export function journalSubmissionHandoff(state: JournalReducerState, clientMessageId: string) {
  const submission = state.submissions.get(clientMessageId)
  if (!submission) {
    return null
  }
  const key = agentJournalSubmissionKey(clientMessageId)
  const scope = state.submissionTurnScopes.get(clientMessageId)
  const providerId = submission.providerItemId
  const uniqueProviderId =
    providerId &&
    [...state.submissions.values()].filter((candidate) => candidate.providerItemId === providerId)
      .length === 1
      ? providerId
      : null
  const matches = [...state.items.values()].flatMap((item) => {
    if (!isRootAgentJournalItem(item)) {
      return []
    }
    const turn = readAgentJournalTurn(item.body)
    if (!turn) {
      return []
    }
    const stated = scope?.kind === 'turn' && scope.turnItemId === item.itemId
    const opener =
      turn.userItemId === key || (uniqueProviderId !== null && turn.userItemId === uniqueProviderId)
    return stated || opener ? [{ itemId: item.itemId, turn }] : []
  })
  return matches.length === 1 ? matches[0] : null
}
