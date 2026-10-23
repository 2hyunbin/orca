import type { JournalReducerState } from './journal-reducer'
import type { JournalTextDeltaRow } from './journal-text-rows'
import { journalTextField, withJournalText } from './journal-text-rows'
import { journalItemRevisionIsStale } from './journal-item-revision'
import { upsertJournalItem } from './journal-item-fold'
import { observeJournalProviderActivity } from './journal-provider-activity'
import { journalItemExecutionFence } from './journal-item-provenance'

export function applyJournalTextDelta(
  state: JournalReducerState,
  row: JournalTextDeltaRow,
  savedAt: number
): void {
  const previous = state.items.get(row.itemId)
  if (journalItemRevisionIsStale(state, row.itemId, row.revision)) {
    return
  }
  const superseded = state.textIndex.supersedes(row.itemId, row.field, row.revision)
  const text = previous ? journalTextField(previous.body, row.field) : null
  if (
    !previous ||
    text === null ||
    (!superseded && (previous.revision !== row.predecessor || text.length !== row.baseLength))
  ) {
    throw new Error('journal_text_predecessor_missing')
  }
  if (!superseded) {
    upsertJournalItem(
      state,
      row.itemId,
      row.revision,
      {
        ...previous,
        revision: row.revision,
        body: withJournalText(previous.body, row.field, text + row.suffix)
      },
      { fence: row.fence, ownerFence: row.ownerFence, executionOwner: row.executionOwner }
    )
  }
  observeJournalProviderActivity(
    state,
    row,
    row.itemId,
    previous.body,
    savedAt,
    journalItemExecutionFence(state, row.itemId) ?? row.fence
  )
}
