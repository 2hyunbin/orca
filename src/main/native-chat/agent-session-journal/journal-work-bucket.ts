import { JournalKeyedHeap } from './journal-keyed-heap'
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
type BucketCheckpoint = {
  head?: Work
  count: number
  nextIncarnation: number
  floorGeneration?: number
}

export class WorkBucket {
  entries: Map<string, Work>
  private heap: JournalKeyedHeap<Slot>
  private nextIncarnation: number
  head?: Work
  private floorGeneration: number

  constructor(
    storage?: JournalStructuralStorage,
    readonly key = '',
    saved?: BucketCheckpoint
  ) {
    this.entries = storage?.map(`work:${key}:entries`) ?? new Map()
    this.heap = new JournalKeyedHeap<Slot>(
      (a, b) => compareAgentJournalItems(a, b) || a.incarnation - b.incarnation,
      storage,
      `work:${key}`,
      saved?.count ?? 0
    )
    this.floorGeneration = saved?.floorGeneration ?? 0
    this.head = saved?.head
    this.nextIncarnation = saved?.nextIncarnation ?? 0
  }

  checkpoint(): BucketCheckpoint {
    return {
      head: this.head,
      count: this.heap.count,
      nextIncarnation: this.nextIncarnation,
      floorGeneration: this.floorGeneration
    }
  }

  fork(): WorkBucket {
    const next = new WorkBucket(undefined, this.key, this.checkpoint())
    next.entries = new JournalMutationMap(this.entries)
    next.heap = this.heap.fork()
    return next
  }

  headAtFloor(generation: number): Work | undefined {
    const top = this.heap.top()
    return generation === this.floorGeneration ? this.head : top && this.entries.get(top.key)
  }

  observeFloor(generation: number): void {
    if (this.floorGeneration !== generation) {
      this.head = this.headAtFloor(generation)
      this.floorGeneration = generation
    }
  }

  update(key: string, work: Work | undefined): void {
    const previous = this.entries.get(key)
    const previousSlot = this.heap.get(key)
    if (work) {
      this.entries.set(key, work)
      this.heap.update(key, {
        key,
        sequence: work.item.sequence,
        sequenceIndex: work.item.sequenceIndex,
        incarnation: previousSlot?.incarnation ?? this.nextIncarnation++
      })
    } else {
      this.entries.delete(key)
      this.heap.update(key, undefined)
    }
    if (previous && previous.item.itemId === this.head?.item.itemId) {
      this.head = work
      if (!work || compareAgentJournalItems(previous.item, work.item) !== 0) {
        this.head = this.heap.top() ? this.entries.get(this.heap.top()!.key) : undefined
      }
    } else if (work && (!this.head || compareAgentJournalItems(work.item, this.head.item) < 0)) {
      this.head = work
    }
  }
}
