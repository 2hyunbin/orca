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
  record: (value: object) => void,
  label: (state: JournalReducerState) => void
): () => void {
  const inspect = (owner: object, fields: readonly string[]) => {
    for (const field of fields) {
      const value: unknown = Reflect.get(owner, field)
      if (value instanceof JournalMutationMap || value instanceof JournalMutationSet) {
        record(value)
      } else if (typeof value === 'object' && value !== null) {
        const source: unknown = Reflect.get(value, 'source')
        if (source instanceof JournalMutationMap || source instanceof JournalMutationSet) {
          record(source)
        }
      }
    }
  }
  const stage = mutationStage.stageJournalMutation
  const staged = vi.spyOn(mutationStage, 'stageJournalMutation').mockImplementation((...args) => {
    const result = stage(...args)
    inspect(result, [
      'items',
      'itemFences',
      'itemExecutionOwners',
      'providerActivityAt',
      'tombstones',
      'submissions',
      'receipts',
      'aliases',
      'itemEchoes',
      'stoppedHistoryCarried',
      'queuedHandOffPlaces',
      'normalizedHandOffs'
    ])
    inspect(result.queue, ['cards'])
    label(result)
    return result
  })
  const fork = JournalRestProjection.prototype.fork
  const rest = vi.spyOn(JournalRestProjection.prototype, 'fork').mockImplementation(function (
    ...args
  ) {
    const result = fork.apply(this, args)
    inspect(result, [
      'requests',
      'clears',
      'cuts',
      'cutAt',
      'cutBuckets',
      'predecessors',
      'submissionWork',
      'origins'
    ])
    return result
  })
  const heapFork = JournalKeyedHeap.prototype.fork
  const heap = vi.spyOn(JournalKeyedHeap.prototype, 'fork').mockImplementation(function () {
    const result = heapFork.call(this)
    inspect(result, ['slots', 'positions'])
    return result
  })
  const workFork = WorkBucket.prototype.fork
  const work = vi.spyOn(WorkBucket.prototype, 'fork').mockImplementation(function () {
    const result = workFork.call(this)
    inspect(result, ['entries'])
    return result
  })
  return () => {
    work.mockRestore()
    heap.mockRestore()
    rest.mockRestore()
    staged.mockRestore()
  }
}
