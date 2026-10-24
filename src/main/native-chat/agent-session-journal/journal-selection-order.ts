import { JournalKeyedHeap } from './journal-keyed-heap'
import type { JournalSelectionStorage } from './journal-selection-storage'

type Entry = { key: string; sequence: number; sequenceIndex?: number; ordinal: number }

/** Plain ordered endpoints share the heap kernel, without WorkBucket's sticky-head policy. */
export class JournalSelectionOrder {
  private readonly counts: Map<string, number>
  constructor(private readonly storage: JournalSelectionStorage) {
    this.counts = storage.map('heapCounts')
  }

  private heap(name: string, lastTie: boolean): JournalKeyedHeap<Entry> {
    return new JournalKeyedHeap<Entry>(
      (a, b) =>
        b.sequence - a.sequence ||
        (b.sequenceIndex ?? 0) - (a.sequenceIndex ?? 0) ||
        (lastTie ? b.ordinal - a.ordinal : a.ordinal - b.ordinal),
      { map: <K, V>(space: string) => this.storage.map<K, V>(space) },
      `order:${name}`,
      this.counts.get(name) ?? 0
    )
  }

  update(name: string, key: string, entry?: Omit<Entry, 'key'>, lastTie = false): void {
    const heap = this.heap(name, lastTie)
    heap.update(key, entry ? { key, ...entry } : undefined)
    this.counts.set(name, heap.count)
  }

  maximum(name: string, lastTie = false): Entry | undefined {
    return this.heap(name, lastTie).top()
  }
}
