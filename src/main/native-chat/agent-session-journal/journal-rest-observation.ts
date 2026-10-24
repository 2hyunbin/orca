import type { JournalReducerState } from './journal-reducer'
import type { Work } from './journal-work-bucket'
import type { SelectionCandidate } from './journal-selection-tree'
import { JournalRestProjectionIndex } from './journal-rest-projection-index'

export abstract class JournalRestObservation extends JournalRestProjectionIndex {
  protected abstract observeOne(state: JournalReducerState, itemId: string): void
  protected abstract trackWork(state: JournalReducerState, key: string, sequence: number): void

  beginObservation(itemId: string): void {
    const meta = this.selection.storage.map<string, number>('observationMeta')
    if ((meta.get('depth') ?? 0) !== 0) {
      throw new Error('overlapping journal observation')
    }
    meta.set('generation', (meta.get('generation') ?? 0) + 1)
    this.push({ kind: 'observe', itemId })
  }

  observe(state: JournalReducerState, itemId: string): void {
    this.beginObservation(itemId)
    while (this.observationStep(state)) {
      // The live writer retains its original synchronous transaction.
    }
  }

  protected push(frame: ObservationFrame): void {
    const meta = this.selection.storage.map<string, number>('observationMeta')
    const depth = meta.get('depth') ?? 0
    this.selection.storage.map<number, ObservationFrame>('observationFrames').set(depth, frame)
    meta.set('depth', depth + 1)
  }

  observationStep(state: JournalReducerState): boolean {
    const meta = this.selection.storage.map<string, number>('observationMeta')
    const depth = meta.get('depth') ?? 0
    if (!depth) {
      return false
    }
    const frames = this.selection.storage.map<number, ObservationFrame>('observationFrames')
    const frame = frames.get(depth - 1)!
    const pop = () => {
      frames.delete(depth - 1)
      meta.set('depth', depth - 1)
    }
    if (frame.kind === 'observe') {
      pop()
      const visited = this.selection.storage.map<string, number>('observationVisits')
      const generation = meta.get('generation') ?? 0
      if (visited.get(frame.itemId) !== generation) {
        visited.set(frame.itemId, generation)
        this.observeOne(state, frame.itemId)
      }
      return true
    }
    if (frame.kind === 'lineage') {
      if (
        frame.at &&
        (!this.requests.has(frame.at) || this.requests.get(frame.at)?.retired) &&
        this.predecessors.has(frame.at)
      ) {
        frames.set(depth - 1, { ...frame, at: this.predecessors.get(frame.at) ?? '' })
      } else {
        this.updateCut(frame.at, frame.sourceKey, frame.work)
        this.cutAt.set(frame.sourceKey, frame.frontier)
        this.cutBuckets.set(frame.sourceKey, frame.at)
        this.trackWork(state, frame.sourceKey, frame.sequence)
        pop()
      }
      return true
    }
    if (frame.phase < 2) {
      const name = frame.phase < 1 ? 'workActive' : 'workCuts'
      const queued = `floorQueue:${frame.token}:${name}`
      if (frame.gather === 'rechecks') {
        const next =
          frame.before === frame.after
            ? undefined
            : this.selection.groups.next('floorRechecks', frame.cursor)
        if (next) {
          frames.set(depth - 1, { ...frame, cursor: next })
          const member = this.selection.tree.candidate(name, next.key)
          if (member) {
            this.selection.groups.update(queued, next.key, true, member.ordinal)
          }
        } else {
          frames.set(depth - 1, { ...frame, gather: 'range', cursor: undefined })
        }
        return true
      }
      if (frame.gather === 'range') {
        const low = Math.min(frame.before, frame.after)
        const high = Math.max(frame.before, frame.after)
        const next =
          frame.before === frame.after
            ? undefined
            : this.selection.tree.next(name, frame.cursor ?? { rank: low, ordinal: Infinity })
        if (next && next.rank <= high) {
          frames.set(depth - 1, { ...frame, cursor: next })
          this.selection.groups.update(queued, next.key, true, next.ordinal)
        } else {
          frames.set(depth - 1, { ...frame, gather: 'drain', cursor: undefined })
        }
        return true
      }
      const next = this.selection.groups.next(queued)
      if (next) {
        this.selection.groups.update(queued, next.key, false)
        this.push({ kind: 'observe', itemId: next.key })
      } else {
        this.selection.groups.releaseEmpty(queued)
        frames.set(depth - 1, {
          ...frame,
          phase: frame.phase + 1,
          gather: 'rechecks',
          cursor: undefined
        })
      }
      return true
    }
    if (frame.phase === 2) {
      const next = frame.changed
        ? this.selection.groups.next(`links:${frame.itemId}`, frame.cursor)
        : undefined
      if (next) {
        frames.set(depth - 1, { ...frame, cursor: next })
        if (next.key !== frame.itemId) {
          this.push({ kind: 'observe', itemId: next.key })
        }
      } else {
        frames.set(depth - 1, { ...frame, phase: 3, cursor: undefined })
      }
      return true
    }
    pop()
    if (frame.parent !== undefined && frame.parent !== frame.itemId) {
      this.push({ kind: 'observe', itemId: frame.parent })
    }
    return true
  }
}

export type ObservationFrame =
  | { kind: 'observe'; itemId: string }
  | {
      kind: 'lineage'
      itemId: string
      sourceKey: string
      frontier: string
      at: string
      work: Work | undefined
      sequence: number
    }
  | {
      kind: 'post'
      itemId: string
      before: number
      after: number
      phase: number
      changed: boolean
      parent?: string
      cursor?: SelectionCandidate
      gather: 'rechecks' | 'range' | 'drain'
      token: number
    }
