import type { JournalReducerState } from './journal-reducer'
import { applyJournalRow } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

import { JournalMutationMap } from './journal-mutation-map'

// Private adapter: reducer maps use get/set/delete/has/iteration/size; edited values are replaced.
export function stageJournalMutation(
  state: JournalReducerState,
  rows: readonly JournalRow[]
): JournalReducerState {
  const staged: JournalReducerState = {
    ...state,
    items: new JournalMutationMap(state.items),
    itemFences: new JournalMutationMap(state.itemFences),
    itemExecutionOwners: new JournalMutationMap(state.itemExecutionOwners),
    providerActivityAt: new JournalMutationMap(state.providerActivityAt),
    tombstones: new JournalMutationMap(state.tombstones),
    submissions: new JournalMutationMap(state.submissions),
    receipts: new JournalMutationMap(state.receipts),
    aliases: new JournalMutationMap(state.aliases),
    itemEchoes: new JournalMutationMap(state.itemEchoes),
    stoppedHistoryCarried: new JournalMutationMap(state.stoppedHistoryCarried),
    // Only membership is needed while staging; the canonical fold adopts these after COMMIT.
    removedTurnIds: new Set(),
    appliedSettlementIds: new Set(state.appliedSettlementIds),
    derivedTurnScope: state.derivedTurnScope.fork(),
    queuePauseMarks: { ...state.queuePauseMarks },
    rest: state.rest.fork()
  }
  for (const row of rows) {
    applyJournalRow(staged, row)
  }
  return staged
}
