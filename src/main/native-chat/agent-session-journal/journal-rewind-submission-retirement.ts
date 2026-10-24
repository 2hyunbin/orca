import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'

export function retireRewoundJournalSubmission(
  state: JournalReducerState,
  itemId: string,
  aliases = true
): void {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca') {
    return
  }
  const raw = state.selection.rawAt(itemId)
  if (raw !== undefined) {
    if (state.submissions.delete(raw)) {
      state.submissionVersion++
    }
    state.receipts.delete(raw)
  }
  while (aliases && retireOneRewoundAlias(state, itemId)) {
    // Live rewind remains synchronous and transactional.
  }
}

export function retireOneRewoundAlias(state: JournalReducerState, itemId: string): boolean {
  if (parseAgentJournalItemKey(itemId)?.provider !== 'orca') {
    return false
  }
  const alias = state.selection.groups.next(`aliases:${itemId}`)?.key
  return alias === undefined ? false : state.aliases.delete(alias)
}
