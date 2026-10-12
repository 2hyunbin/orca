// Why: a client removes a closed tab at once, but its host keeps publishing lists that still name the
// tab until it has handled the close. One record per close hides the tab from those lists until the
// host's own list stops naming it, and lets it back the moment the close fails.

/** How the host answered a close: accepted, has no such tab, or did not close it. */
export type SessionTabCloseOutcome = 'closed' | 'absent' | 'failed'

/** Matches a close call's own timeout; an entry no answer settled by then counts as failed. */
export const SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS = 15_000
// Why: the record outlives its caller's limit, so an answer the caller still accepts always lands.
export const SESSION_TAB_CLOSE_UNSETTLED_EXPIRY_MS = SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS + 5_000
/** Only bounds memory when no list arrives after the host accepted the close. */
export const SESSION_TAB_CLOSE_SETTLED_TTL_MS = 20_000
export const MAX_SESSION_TAB_CLOSE_PARTITIONS = 512

type Entry = {
  state: 'unsettled' | SessionTabCloseOutcome
  since: number
  // Why: the host's removal can be applied before its answer arrives; a settled close then ends at once.
  omittedByLatest: boolean
}

export type SessionTabCloseTicket = {
  readonly partition: string
  readonly closedId: string
  readonly entry: object
}

export type SessionTabCloseLedgerOptions = {
  unsettledBoundMs?: number
  settledTtlMs?: number
  maxPartitions?: number
}

/**
 * Pending tab closes, per partition (one host list a client applies) and per closed id. A list tab
 * matches an entry when its id or its top-level id is the closed id, so a tab entry hides its panes
 * and a pane entry hides only that pane.
 */
export class SessionTabCloseLedger {
  private readonly partitions = new Map<string, Map<string, Entry>>()
  private readonly unsettledBoundMs: number
  private readonly settledTtlMs: number
  private readonly maxPartitions: number

  constructor(options: SessionTabCloseLedgerOptions = {}) {
    this.unsettledBoundMs = options.unsettledBoundMs ?? SESSION_TAB_CLOSE_UNSETTLED_EXPIRY_MS
    this.settledTtlMs = options.settledTtlMs ?? SESSION_TAB_CLOSE_SETTLED_TTL_MS
    this.maxPartitions = options.maxPartitions ?? MAX_SESSION_TAB_CLOSE_PARTITIONS
  }

  begin(partition: string, closedId: string, now: number): SessionTabCloseTicket | null {
    const id = closedId.trim()
    if (!partition || !id) {
      return null
    }
    let entries = this.partitions.get(partition)
    if (!entries) {
      while (this.partitions.size >= this.maxPartitions) {
        const oldest = this.partitions.keys().next()
        if (oldest.done) {
          break
        }
        this.partitions.delete(oldest.value)
      }
      entries = new Map()
      this.partitions.set(partition, entries)
    }
    const entry: Entry = { state: 'unsettled', since: now, omittedByLatest: false }
    entries.set(id, entry)
    return { partition, closedId: id, entry }
  }

  /** Returns false when the entry was already replaced or expired; the answer is then ignored. */
  settle(ticket: SessionTabCloseTicket, outcome: SessionTabCloseOutcome, now: number): boolean {
    const entries = this.partitions.get(ticket.partition)
    const entry = entries?.get(ticket.closedId)
    if (!entries || entry !== ticket.entry || this.expired(entry, now)) {
      if (entry && entry === ticket.entry) {
        this.remove(ticket.partition, ticket.closedId)
      }
      return false
    }
    if (outcome === 'failed') {
      // Keep this operation identity until deferred recovery consumes it, without hiding the tab.
      entry.state = outcome
      entry.since = now
      return true
    }
    if (entry.omittedByLatest) {
      this.remove(ticket.partition, ticket.closedId)
      return true
    }
    entry.state = outcome === 'absent' ? 'absent' : 'closed'
    entry.since = now
    return true
  }

  /** Consumes only this failed operation; a newer close owns recovery instead. */
  takeFailed(ticket: SessionTabCloseTicket, now: number): boolean {
    const entry = this.partitions.get(ticket.partition)?.get(ticket.closedId)
    if (entry !== ticket.entry || entry.state !== 'failed') {
      return false
    }
    this.remove(ticket.partition, ticket.closedId)
    return !this.expired(entry, now)
  }

  /** Whether a close of exactly this id is still hiding it; reads only, ends nothing. */
  isPending(partition: string, closedId: string, now: number): boolean {
    const entry = this.partitions.get(partition)?.get(closedId)
    return entry !== undefined && entry.state !== 'failed' && !this.expired(entry, now)
  }

  hasPending(partition: string, now: number): boolean {
    const entries = this.partitions.get(partition)
    if (!entries) {
      return false
    }
    for (const [closedId, entry] of entries) {
      if (this.expired(entry, now)) {
        entries.delete(closedId)
      }
    }
    if (entries.size === 0) {
      this.partitions.delete(partition)
      return false
    }
    return [...entries.values()].some((entry) => entry.state !== 'failed')
  }

  /**
   * Applies one host list: ends settled entries it no longer names, then drops tabs still being
   * closed. Returns the input array when nothing is hidden.
   */
  filter<T extends { id: string }>(
    partition: string,
    tabs: readonly T[],
    topLevelIdOf: (tab: T) => string,
    now: number,
    confirmOmission: boolean | ((closedId: string) => boolean) = true
  ): readonly T[] {
    const entries = this.partitions.get(partition)
    if (!entries) {
      return tabs
    }
    const named = new Set<string>()
    for (const tab of tabs) {
      named.add(tab.id)
      named.add(topLevelIdOf(tab))
    }
    for (const [closedId, entry] of entries) {
      const omitted = !named.has(closedId)
      const confirms =
        typeof confirmOmission === 'function' ? confirmOmission(closedId) : confirmOmission
      if (confirms) {
        entry.omittedByLatest = omitted
      }
      if (this.expired(entry, now) || (confirms && omitted && entry.state !== 'unsettled')) {
        entries.delete(closedId)
      }
    }
    if (entries.size === 0) {
      this.partitions.delete(partition)
      return tabs
    }
    const hides = (id: string): boolean => {
      const entry = entries.get(id)
      return entry !== undefined && entry.state !== 'failed'
    }
    const visible = tabs.filter((tab) => !hides(tab.id) && !hides(topLevelIdOf(tab)))
    return visible.length === tabs.length ? tabs : visible
  }

  clearPartition(partition: string): void {
    this.partitions.delete(partition)
  }

  reset(): void {
    this.partitions.clear()
  }

  private expired(entry: Entry, now: number): boolean {
    if (entry.state === 'unsettled') {
      return now - entry.since > this.unsettledBoundMs
    }
    return entry.state !== 'absent' && now - entry.since > this.settledTtlMs
  }

  private remove(partition: string, closedId: string): void {
    const entries = this.partitions.get(partition)
    entries?.delete(closedId)
    if (entries?.size === 0) {
      this.partitions.delete(partition)
    }
  }
}
