import type { JournalReducerState } from './journal-reducer'

/** Covers direct effective writes as well as ordinary item upserts. */
class SourceMap<K, V> extends Map<K, V> {
  constructor(
    readonly source: Map<K, V>,
    private readonly changed: (key: K, value: V | undefined, previous: V | undefined) => void
  ) {
    super()
  }

  override get(key: K): V | undefined {
    return this.source.get(key)
  }

  override has(key: K): boolean {
    return this.source.has(key)
  }

  override set(key: K, value: V): this {
    const previous = this.source.get(key)
    this.source.set(key, value)
    this.changed(key, value, previous)
    return this
  }

  override delete(key: K): boolean {
    const previous = this.source.get(key)
    const deleted = this.source.delete(key)
    if (deleted) {
      this.changed(key, undefined, previous)
    }
    return deleted
  }

  override entries() {
    return this.source.entries()
  }

  override keys() {
    return this.source.keys()
  }

  override values() {
    return this.source.values()
  }

  override [Symbol.iterator]() {
    return this.entries()
  }

  override get size(): number {
    return this.source.size
  }
}

export function journalSourceMap<K, V>(map: Map<K, V>): Map<K, V> {
  return map instanceof SourceMap ? map.source : map
}

class NormalizedSet extends Set<string> {
  constructor(
    readonly source: Set<string>,
    private readonly changed: (key: string) => void
  ) {
    super()
  }

  override add(key: string): this {
    this.source.add(key)
    this.changed(key)
    return this
  }

  override delete(key: string): boolean {
    const removed = this.source.delete(key)
    this.changed(key)
    return removed
  }

  override has(key: string): boolean {
    return this.source.has(key)
  }

  override values() {
    return this.source.values()
  }

  override keys() {
    return this.source.keys()
  }

  override entries() {
    return this.source.entries()
  }

  override [Symbol.iterator]() {
    return this.values()
  }

  override get size(): number {
    return this.source.size
  }
}

export function bindJournalSelection(state: JournalReducerState): JournalReducerState {
  state.items = new SourceMap(journalSourceMap(state.items), (key, value, previous) => {
    state.selection.itemChanged(key, value, previous, state)
  })
  state.submissions = new SourceMap(journalSourceMap(state.submissions), (key, value) => {
    state.selection.submissionChanged(key, value, state)
  })
  state.aliases = new SourceMap(journalSourceMap(state.aliases), (key, value, previous) => {
    state.selection.aliasChanged(key, value, previous, state)
  })
  state.queue.cards = new SourceMap(journalSourceMap(state.queue.cards), (key, value, previous) => {
    state.selection.cardChanged(key, value, previous, state)
  })
  const normalized = state.normalizedHandOffs
  state.normalizedHandOffs = new NormalizedSet(
    normalized instanceof NormalizedSet ? normalized.source : normalized,
    (key) => state.selection.normalizationChanged(key, state)
  )
  return state
}
