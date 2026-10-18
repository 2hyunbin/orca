import { randomUUID } from 'node:crypto'
import {
  SIDEBAR_INPUTS_PAGE_MAX_BYTES,
  SIDEBAR_INPUTS_PAGE_MIN_BYTES,
  SIDEBAR_INPUTS_SCHEMA_VERSION,
  SIDEBAR_INPUTS_SEMANTICS_VERSION,
  type SidebarInputsChangedEvent,
  type SidebarInputsReadParams,
  type SidebarInputsReadResult
} from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import {
  feedEntity,
  paginateFeedChanges,
  type FeedChange,
  type FeedEntity
} from './sidebar-inputs-feed-pages'
import { FeedChangeLog, type FeedRevisionChanges } from './sidebar-inputs-feed-log'
import { FeedPins, feedPageToken } from './sidebar-inputs-feed-pins'

/** One producer's snapshot, as entities keyed so that none is needlessly large. */
export type SidebarInputsFeedDomain = {
  name: string
  read: () => Record<string, unknown> | Promise<Record<string, unknown>>
  /** Calls `changed` after anything `read` depends on may have changed; returns the detach. */
  watch: (changed: () => void) => () => void
  /** Some of its sources announce no change, so every phone read re-reads it first. */
  rereadOnRead?: boolean
}

// One revision per burst of producer changes.
const FLUSH_COALESCE_MS = 50

/**
 * The phone's copy of the sidebar inputs, served from the producers' own snapshots. Everything
 * here (published entities, log, pinned pages) exists only while a phone is subscribed; the
 * producers run regardless, since the desktop reads them too.
 */
export class SidebarInputsFeed {
  readonly generation = randomUUID()
  private revision = 0
  private readonly subscribers = new Set<string>()
  private session: FeedSession | null = null

  constructor(
    private readonly domains: () => readonly SidebarInputsFeedDomain[],
    private readonly emit: (event: SidebarInputsChangedEvent) => void
  ) {}

  /** True when `subscriberId` was not yet subscribed, so its caller owns the matching release. */
  acquire(subscriberId: string): boolean {
    if (this.subscribers.has(subscriberId)) {
      return false
    }
    this.subscribers.add(subscriberId)
    if (!this.session) {
      // The empty set is a revision of its own, so a cursor from before this session reads afresh.
      this.revision += 1
      this.session = new FeedSession(this.domains(), this.revision, (revision) => {
        this.revision = revision
        this.emit({ type: 'sidebarInputsChanged', generation: this.generation, revision })
      })
    }
    return true
  }

  release(subscriberId: string): void {
    if (this.subscribers.delete(subscriberId) && this.subscribers.size === 0) {
      this.session?.dispose()
      this.session = null
    }
  }

  async read(params: SidebarInputsReadParams): Promise<SidebarInputsReadResult> {
    const session = this.session
    if (!session) {
      throw new Error('sidebar inputs feed has no subscriber')
    }
    const result = await session.read(params, this.generation)
    // A release during the read discarded what it read from.
    return this.session === session
      ? result
      : feedReply(this.generation, 'reset', this.revision, null, {}, null)
  }
}

function feedReply(
  generation: string,
  kind: SidebarInputsReadResult['kind'],
  revision: number,
  from: number | null,
  domains: SidebarInputsReadResult['domains'],
  next: string | null
): SidebarInputsReadResult {
  return {
    generation,
    revision,
    schemaVersion: SIDEBAR_INPUTS_SCHEMA_VERSION,
    semanticsVersion: SIDEBAR_INPUTS_SEMANTICS_VERSION,
    kind,
    from,
    domains,
    next
  }
}

class FeedSession {
  private readonly published = new Map<string, Map<string, FeedEntity>>()
  private readonly dirty = new Set<string>()
  private readonly log: FeedChangeLog
  private readonly pins = new FeedPins()
  private readonly detaches: (() => void)[]
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> | null = null
  private disposed = false

  constructor(
    private readonly domains: readonly SidebarInputsFeedDomain[],
    private revision: number,
    private readonly committed: (revision: number) => void
  ) {
    this.log = new FeedChangeLog(revision)
    for (const domain of domains) {
      this.dirty.add(domain.name)
    }
    this.detaches = domains.map((domain) => domain.watch(() => this.invalidate(domain.name)))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    for (const detach of this.detaches) {
      detach()
    }
  }

  async read(
    params: SidebarInputsReadParams,
    generation: string
  ): Promise<SidebarInputsReadResult> {
    if (params.pageToken !== undefined) {
      return (
        this.pins.page(params.pageToken) ??
        feedReply(generation, 'reset', this.revision, null, {}, null)
      )
    }
    for (const domain of this.domains) {
      if (domain.rereadOnRead) {
        this.dirty.add(domain.name)
      }
    }
    await this.flushNow()
    const budget = Math.min(
      SIDEBAR_INPUTS_PAGE_MAX_BYTES,
      Math.max(SIDEBAR_INPUTS_PAGE_MIN_BYTES, params.maxBytes)
    )
    const { cursor } = params
    // Generations have no order: any other one, or a cursor the log no longer reaches, reads afresh.
    if (
      params.generation === generation &&
      cursor !== undefined &&
      this.log.covers(cursor, this.revision)
    ) {
      return this.batch(`delta:${cursor}`, generation, cursor, budget, () => this.log.since(cursor))
    }
    return this.batch('snapshot', generation, null, budget, () => this.everything())
  }

  private invalidate(name: string): void {
    if (this.disposed) {
      return
    }
    this.dirty.add(name)
    this.timer ??= setTimeout(() => {
      this.timer = null
      void this.flushNow()
    }, FLUSH_COALESCE_MS)
  }

  private flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flushing ??= this.flush().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async flush(): Promise<void> {
    while (this.dirty.size > 0 && !this.disposed) {
      const due = this.domains.filter((domain) => this.dirty.has(domain.name))
      this.dirty.clear()
      const reads = await Promise.all(due.map((domain) => readDomain(domain)))
      if (this.disposed) {
        return
      }
      const changes: FeedRevisionChanges = new Map()
      due.forEach((domain, index) => {
        const changed = this.publish(domain.name, reads[index])
        if (changed.size > 0) {
          changes.set(domain.name, changed)
        }
      })
      if (changes.size > 0) {
        this.revision += 1
        this.log.append(this.revision, changes)
        this.committed(this.revision)
      }
    }
  }

  /** Replaces a domain's published entities; returns what changed. A failed read changes nothing. */
  private publish(
    name: string,
    next: Map<string, FeedEntity> | null
  ): Map<string, FeedEntity | null> {
    const changed = new Map<string, FeedEntity | null>()
    if (!next) {
      return changed
    }
    const before = this.published.get(name) ?? new Map<string, FeedEntity>()
    for (const [key, entity] of next) {
      if (before.get(key)?.json !== entity.json) {
        changed.set(key, entity)
      }
    }
    for (const key of before.keys()) {
      if (!next.has(key)) {
        changed.set(key, null)
      }
    }
    this.published.set(name, next)
    return changed
  }

  private *everything(): Iterable<FeedChange> {
    for (const domain of this.domains) {
      for (const [key, entity] of this.published.get(domain.name) ?? []) {
        yield [domain.name, key, entity]
      }
    }
  }

  /** The batch at this revision, pinned for its later pages; a reader at the same place shares it. */
  private batch(
    shape: string,
    generation: string,
    from: number | null,
    budget: number,
    changes: () => Iterable<FeedChange>
  ): SidebarInputsReadResult {
    const key = `${shape}:${this.revision}:${budget}`
    const pinned = this.pins.find(key)
    if (pinned) {
      return pinned[0]
    }
    const bodies = paginateFeedChanges(changes(), budget)
    const pages = bodies.map((body, index) =>
      feedReply(
        generation,
        from === null ? 'snapshot' : 'delta',
        this.revision,
        from,
        body.domains,
        index + 1 < bodies.length ? feedPageToken(key, index + 1) : null
      )
    )
    if (pages.length > 1) {
      this.pins.add(
        key,
        pages,
        bodies.reduce((sum, body) => sum + body.bytes, 0)
      )
    }
    return pages[0]
  }
}

async function readDomain(
  domain: SidebarInputsFeedDomain
): Promise<Map<string, FeedEntity> | null> {
  try {
    const entities = new Map<string, FeedEntity>()
    for (const [key, value] of Object.entries(await domain.read())) {
      if (value !== undefined) {
        entities.set(key, feedEntity(value))
      }
    }
    return entities
  } catch (error) {
    // The domain keeps what it last published; its next change or read tries again.
    console.warn(`[sidebar-inputs-feed] could not read ${domain.name}`, error)
    return null
  }
}
