import {
  populationSource,
  populationRestCollections,
  populationHeapCollections
} from './journal-population-observation-test-support'
import { vi } from 'vitest'
import * as mutationStage from './journal-mutation-stage'
import { JournalMutationMap } from './journal-mutation-map'
import { JournalMutationSet } from './journal-mutation-set'
import { JournalRestProjection } from './journal-rest-projection'
import { WorkBucket } from './journal-work-bucket'
import { JournalKeyedHeap } from './journal-keyed-heap'
import type { JournalReducerState } from './journal-reducer'

/** Fixed field inventory counts COW construction without walking any retained entries. */
export function instrumentPopulationStaging(
  record: <Key, Value>(value: JournalMutationMap<Key, Value> | JournalMutationSet<Key>) => void,
  label: (state: JournalReducerState) => void
): () => void {
  const inspect = (values: readonly unknown[]) => {
    for (const value of values) {
      if (value instanceof JournalMutationMap || value instanceof JournalMutationSet) {
        record(value)
      } else if (typeof value === 'object' && value !== null) {
        const source = populationSource(value)
        if (source instanceof JournalMutationMap || source instanceof JournalMutationSet) {
          record(source)
        }
      }
    }
  }
  const stage = mutationStage.stageJournalMutation
  const staged = vi.spyOn(mutationStage, 'stageJournalMutation').mockImplementation((...args) => {
    const result = stage(...args)
    inspect([
      result.items,
      result.itemFences,
      result.itemExecutionOwners,
      result.providerActivityAt,
      result.tombstones,
      result.submissions,
      result.receipts,
      result.aliases,
      result.itemEchoes,
      result.stoppedHistoryCarried,
      result.queuedHandOffPlaces,
      result.normalizedHandOffs
    ])
    inspect([result.queue.cards])
    label(result)
    return result
  })
  const fork = JournalRestProjection.prototype.fork
  const rest = vi.spyOn(JournalRestProjection.prototype, 'fork').mockImplementation(function (
    ...args
  ) {
    const result = fork.apply(this, args)
    inspect(populationRestCollections(result).map(([, value]) => value))
    return result
  })
  const heapFork = JournalKeyedHeap.prototype.fork
  const heap = vi.spyOn(JournalKeyedHeap.prototype, 'fork').mockImplementation(function () {
    const result = heapFork.call(this)
    inspect(populationHeapCollections(result))
    return result
  })
  const workFork = WorkBucket.prototype.fork
  const work = vi.spyOn(WorkBucket.prototype, 'fork').mockImplementation(function () {
    const result = workFork.call(this)
    inspect([result.entries])
    return result
  })
  return () => {
    work.mockRestore()
    heap.mockRestore()
    rest.mockRestore()
    staged.mockRestore()
  }
}
