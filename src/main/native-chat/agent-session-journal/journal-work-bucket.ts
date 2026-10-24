import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import { JournalMutationMap } from './journal-mutation-map'
import type { JournalRestFacts } from './journal-row-table'
import type { JournalStructuralStorage } from './journal-rest-projection-index'

export type Work = { fact: NonNullable<JournalRestFacts['openTurn']>; item: AgentJournalRenderItem }
type Slot = Pick<AgentJournalRenderItem, 'sequence' | 'sequenceIndex'> & {
  key: string
  incarnation: number
}
type BucketCheckpoint = { head?: Work; count: number; nextIncarnation: number }

export class WorkBucket {
  entries: Map<string, Work>
  private slots: Map<number, Slot>
  private positions: Map<string, number>
  private count: number
  private nextIncarnation: number
  head?: Work

  constructor(
    storage?: JournalStructuralStorage,
    readonly key = '',
    saved?: BucketCheckpoint
  ) {
    this.entries = storage?.map(`work:${key}:entries`) ?? new Map()
    this.slots = storage?.map(`work:${key}:slots`) ?? new Map()
    this.positions = storage?.map(`work:${key}:positions`) ?? new Map()
    this.head = saved?.head
    this.count = saved?.count ?? 0
    this.nextIncarnation = saved?.nextIncarnation ?? 0
  }

  checkpoint(): BucketCheckpoint {
    return { head: this.head, count: this.count, nextIncarnation: this.nextIncarnation }
  }

  fork(): WorkBucket {
    const next = new WorkBucket(undefined, this.key, this.checkpoint())
    next.entries = new JournalMutationMap(this.entries)
    next.slots = new JournalMutationMap(this.slots)
    next.positions = new JournalMutationMap(this.positions)
    return next
  }

  private slot(index: number): Slot {
    const slot = this.slots.get(index)
    if (!slot) {
      throw new Error('missing journal work index slot')
    }
    return slot
  }

  private compare(a: Slot, b: Slot): number {
    return compareAgentJournalItems(a, b) || a.incarnation - b.incarnation
  }

  private place(index: number, slot: Slot): void {
    this.slots.set(index, slot)
    this.positions.set(slot.key, index)
  }

  private sift(index: number, slot: Slot): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      const parent = this.slot(parentIndex)
      if (this.compare(slot, parent) >= 0) {
        break
      }
      this.place(index, parent)
      index = parentIndex
    }
    for (;;) {
      const leftIndex = 2 * index + 1
      if (leftIndex >= this.count) {
        break
      }
      let childIndex = leftIndex
      let child = this.slot(leftIndex)
      if (leftIndex + 1 < this.count) {
        const right = this.slot(leftIndex + 1)
        if (this.compare(right, child) < 0) {
          childIndex++
          child = right
        }
      }
      if (this.compare(slot, child) <= 0) {
        break
      }
      this.place(index, child)
      index = childIndex
    }
    this.place(index, slot)
  }

  update(key: string, work: Work | undefined): void {
    const previous = this.entries.get(key)
    const index = this.positions.get(key)
    if (work) {
      this.entries.set(key, work)
      const incarnation =
        index === undefined ? this.nextIncarnation++ : this.slot(index).incarnation
      const slot = {
        key,
        sequence: work.item.sequence,
        sequenceIndex: work.item.sequenceIndex,
        incarnation
      }
      this.sift(index ?? this.count++, slot)
    } else {
      this.entries.delete(key)
      if (index !== undefined) {
        const last = this.slot(--this.count)
        this.slots.delete(this.count)
        this.positions.delete(key)
        if (index < this.count) {
          this.sift(index, last)
        }
      }
    }
    if (previous && previous.item.itemId === this.head?.item.itemId) {
      this.head = work
      if (!work || compareAgentJournalItems(previous.item, work.item) !== 0) {
        this.head = this.count ? this.entries.get(this.slot(0).key) : undefined
      }
    } else if (work && (!this.head || compareAgentJournalItems(work.item, this.head.item) < 0)) {
      this.head = work
    }
  }
}
