import type { AgentSessionSemanticWork } from '../../../shared/agent-session-semantic-work'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import { JournalMutationMap } from './journal-mutation-map'
import type { JournalRestFacts } from './journal-row-table'

export type Request = { item: AgentJournalRenderItem; anchor: string; retired?: true }

export type Work = { fact: NonNullable<JournalRestFacts['openTurn']>; item: AgentJournalRenderItem }
export type JournalStructuralStorage = {
  map<K, V, Stored = V>(
    name: string,
    codec?: { encode: (value: V) => Stored; decode: (value: Stored) => V }
  ): Map<K, V>
  set<T>(name: string): Set<T>
}

export class WorkBucket {
  constructor(
    public entries = new Map<string, Work>(),
    public head?: Work,
    readonly key = ''
  ) {}
  fork(): WorkBucket {
    const next = new WorkBucket()
    next.entries = new JournalMutationMap(this.entries)
    next.head = this.head
    return next
  }
  update(key: string, work: Work | undefined): void {
    const previous = this.entries.get(key)
    if (work) {
      this.entries.set(key, work)
    } else {
      this.entries.delete(key)
    }
    if (previous && previous.item.itemId === this.head?.item.itemId) {
      this.head = work
      if (!work || compareAgentJournalItems(previous.item, work.item) !== 0) {
        this.head = undefined
        for (const candidate of this.entries.values()) {
          if (!this.head || compareAgentJournalItems(candidate.item, this.head.item) < 0) {
            this.head = candidate
          }
        }
      }
    } else if (work && (!this.head || compareAgentJournalItems(work.item, this.head.item) < 0)) {
      this.head = work
    }
  }
}

/** A compact index of canonical requests, including finished heads that supersede older cuts. */
export class JournalRestProjectionIndex {
  protected requests = new Map<string, Request>()
  protected clears = new Map<string, number>()
  protected users = new Map<string, Set<string>>()
  protected latest: Request | undefined
  revision = 0
  protected dirty = false
  protected floor = 0
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
    saved?: ReturnType<JournalRestProjectionIndex['checkpoint']>
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
      encode: (bucket: WorkBucket) => ({ key: bucket.key, head: bucket.head }),
      decode: (value) => new WorkBucket(storage.map(`bucket:${value.key}`), value.head, value.key)
    })
    this.active = new WorkBucket(storage.map('active'), saved?.active)
    if (saved) {
      this.latest = saved.latest
      this.floor = saved.floor
      this.dirty = saved.dirty
      this.revision = saved.revision
      this.legacy = saved.legacy
    }
  }

  checkpoint() {
    return {
      latest: this.latest,
      floor: this.floor,
      dirty: this.dirty,
      revision: this.revision,
      legacy: this.legacy,
      active: this.active.head
    }
  }

  protected linked(key: string, create = false): Set<string> {
    if (this.storage) {
      return this.storage.set(`links:${key}`)
    }
    let linked = this.users.get(key)
    if (!linked) {
      linked = new Set()
      if (create) {
        this.users.set(key, linked)
      }
    }
    return linked
  }

  protected updateCut(anchor: string, key: string, work: Work | undefined): void {
    const bucket =
      this.cuts.get(anchor) ??
      new WorkBucket(this.storage?.map(`bucket:${anchor}`), undefined, anchor)
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
      this.latest = undefined
      for (const candidate of this.requests.values()) {
        if (
          !candidate.retired &&
          candidate.item.sequence > this.floor &&
          (!this.latest || compareAgentJournalItems(candidate.item, this.latest.item) > 0)
        ) {
          this.latest = candidate
        }
      }
      this.dirty = false
    }
    const anchor = this.latest?.anchor ?? null
    return (
      this.active.head?.fact ??
      this.cuts.get(anchor ?? '')?.head?.fact ??
      (this.legacy?.frontier === anchor ? this.legacy.fact : null)
    )
  }
}
