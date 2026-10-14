// Execution provenance: the generation whose execution produced an item (`JournalItemRow.ownerFence`),
// kept apart from each row's writer fence. A provider's observation states it; host bookkeeping
// keeps the item's.

import type { JournalReducerState } from './journal-reducer'

/** The provenance a row states: the writer's own claim when it has one — a provider's observation,
 *  or history carried into a new epoch — else host bookkeeping's, which keeps the item's, and for
 *  an item it creates is the fence it writes at. Every item row states it. */
export function journalItemOwnerFence(
  state: Pick<JournalReducerState, 'itemFences' | 'items'>,
  resolvedItemId: string,
  write: { fence: number; ownerFence?: number }
): number {
  if (write.ownerFence !== undefined) {
    return write.ownerFence
  }
  const kept = state.items.has(resolvedItemId) ? state.itemFences.get(resolvedItemId) : undefined
  return kept ?? write.fence
}
