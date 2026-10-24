import { JournalSelection } from './journal-selection'
import type { AgentSessionSemanticWork } from '../../../shared/agent-session-semantic-work'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { WorkBucket, type Work } from './journal-work-bucket'
import type { JournalRestFacts } from './journal-row-table'

export type Request = { item: AgentJournalRenderItem; anchor: string; retired?: true }

export type JournalStructuralStorage = {
  map<K, V, Stored = V>(
    name: string,
    codec?: { encode: (value: V) => Stored; decode: (value: Stored) => V }
  ): Map<K, V>
  set<T>(name: string): Set<T>
}

/** A compact index of canonical requests, including finished heads that supersede older cuts. */
export class JournalRestProjectionIndex {
  protected requests = new Map<string, Request>()
  protected clears = new Map<string, number>()
  protected latest: Request | undefined
  revision = 0
  protected dirty = false
  protected floor = 0
  protected floorGeneration = 0
  protected active = new WorkBucket()
  protected cuts = new Map<string, WorkBucket>()
  protected cutAt = new Map<string, string>()
  protected cutBuckets = new Map<string, string>()
  protected predecessors = new Map<string, string | null>()
  protected submissionWork = new Map<string, string>()
  protected origins = new Map<string, AgentSessionSemanticWork>()
  protected legacy:
    | { fact: NonNullable<JournalRestFacts['openTurn']>; frontier: string | null }
    | undefined

  constructor(
    protected readonly storage?: JournalStructuralStorage,
    saved?: ReturnType<JournalRestProjectionIndex['checkpoint']>,
    protected selection = new JournalSelection(storage)
  ) {
    if (!storage) {
      return
    }
    this.requests = storage.map('requests')
    this.clears = storage.map('clears')
    this.cutAt = storage.map('cutAt')
    this.cutBuckets = storage.map('cutBuckets')
    this.predecessors = storage.map('predecessors')
    this.submissionWork = storage.map('submissionWork')
    this.origins = storage.map('origins')
    this.cuts = storage.map('cuts', {
      encode: (bucket: WorkBucket) => ({ key: bucket.key, ...bucket.checkpoint() }),
      decode: (value) => new WorkBucket(storage, value.key, value)
    })
    this.active = new WorkBucket(storage, 'active', saved?.active)
    if (saved) {
      this.latest = saved.latest
      this.floor = saved.floor
      this.floorGeneration = saved.floorGeneration ?? 0
      this.dirty = saved.dirty
      this.revision = saved.revision
      this.legacy = saved.legacy
    }
  }

  checkpoint() {
    return {
      latest: this.latest,
      floor: this.floor,
      floorGeneration: this.floorGeneration,
      dirty: this.dirty,
      revision: this.revision,
      legacy: this.legacy,
      active: this.active.checkpoint()
    }
  }

  protected updateCut(anchor: string, key: string, work: Work | undefined): void {
    const bucket = this.cuts.get(anchor) ?? new WorkBucket(this.storage, `cut:${anchor}`)
    bucket.observeFloor(this.floorGeneration)
    bucket.update(key, work)
    this.cuts.set(anchor, bucket)
  }

  retainedFrontier(anchor: string | null, retained: ReadonlySet<string>): string | null {
    while (anchor && !retained.has(anchor)) {
      anchor = this.predecessors.get(anchor) ?? null
    }
    return anchor
  }

  frontier(): string | null {
    this.fact()
    return this.latest?.anchor ?? null
  }

  seedLegacy(pair: readonly [string | null, number | null], frontier = this.frontier()): void {
    if (pair[0] === '' && pair[1] !== null) {
      this.legacy = { fact: { itemId: '', since: pair[1] }, frontier }
    }
  }

  fact(): JournalRestFacts['openTurn'] {
    if (this.dirty) {
      const key = this.selection.order.maximum('requests')?.key
      const candidate = key === undefined ? undefined : this.requests.get(key)
      this.latest = candidate && candidate.item.sequence > this.floor ? candidate : undefined
      this.dirty = false
    }
    const anchor = this.latest?.anchor ?? null
    return (
      this.active.head?.fact ??
      this.cuts.get(anchor ?? '')?.headAtFloor(this.floorGeneration)?.fact ??
      (this.legacy?.frontier === anchor ? this.legacy.fact : null)
    )
  }
}
