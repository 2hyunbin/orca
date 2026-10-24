import { JournalMutationMap } from './journal-mutation-map'

/** Mechanical ordering only; callers retain entry lifetime and sticky-head policy. */
export class JournalKeyedHeap<T extends { key: string }> {
  private slots: Map<number, T>
  private positions: Map<string, number>
  count: number

  constructor(
    private readonly compare: (a: T, b: T) => number,
    storage?: { map<K, V>(name: string): Map<K, V> },
    private readonly name = '',
    count = 0
  ) {
    this.slots = storage?.map(`${name}:slots`) ?? new Map()
    this.positions = storage?.map(`${name}:positions`) ?? new Map()
    this.count = count
  }

  fork(): JournalKeyedHeap<T> {
    const next = new JournalKeyedHeap(this.compare, undefined, this.name, this.count)
    next.slots = new JournalMutationMap(this.slots)
    next.positions = new JournalMutationMap(this.positions)
    return next
  }

  top(): T | undefined {
    return this.count ? this.slot(0) : undefined
  }

  get(key: string): T | undefined {
    const index = this.positions.get(key)
    return index === undefined ? undefined : this.slot(index)
  }

  update(key: string, value: T | undefined): void {
    const index = this.positions.get(key)
    if (value) {
      this.sift(index ?? this.count++, value)
    } else if (index !== undefined) {
      const last = this.slot(--this.count)
      this.slots.delete(this.count)
      this.positions.delete(key)
      if (index < this.count) {
        this.sift(index, last)
      }
    }
  }

  private slot(index: number): T {
    const value = this.slots.get(index)
    if (!value) {
      throw new Error('missing journal ordering slot')
    }
    return value
  }

  private place(index: number, value: T): void {
    this.slots.set(index, value)
    this.positions.set(value.key, index)
  }

  private sift(index: number, value: T): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      const parent = this.slot(parentIndex)
      if (this.compare(value, parent) >= 0) {
        break
      }
      this.place(index, parent)
      index = parentIndex
    }
    for (;;) {
      const left = 2 * index + 1
      if (left >= this.count) {
        break
      }
      let childIndex = left
      let child = this.slot(left)
      if (left + 1 < this.count) {
        const right = this.slot(left + 1)
        if (this.compare(right, child) < 0) {
          childIndex++
          child = right
        }
      }
      if (this.compare(value, child) <= 0) {
        break
      }
      this.place(index, child)
      index = childIndex
    }
    this.place(index, value)
  }
}
