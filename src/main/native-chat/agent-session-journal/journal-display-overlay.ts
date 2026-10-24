/** Current raw owner plus per-key corrections, without a retained base copy or overlay chain. */
export class JournalDisplayOverlay<K, V> extends Map<K, V> {
  constructor(
    private readonly base: ReadonlyMap<K, V>,
    private readonly corrections: ReadonlyMap<K, V>
  ) {
    super()
  }

  override get(key: K): V | undefined {
    return this.corrections.has(key) ? this.corrections.get(key) : this.base.get(key)
  }

  override has(key: K): boolean {
    return this.corrections.has(key) || this.base.has(key)
  }

  override *entries(): MapIterator<[K, V]> {
    for (const [key, value] of this.base) {
      yield [key, this.corrections.get(key) ?? value]
    }
    for (const entry of this.corrections) {
      if (!this.base.has(entry[0])) {
        yield entry
      }
    }
  }

  override [Symbol.iterator]() {
    return this.entries()
  }

  override *keys() {
    for (const [key] of this) {
      yield key
    }
  }

  override *values() {
    for (const [, value] of this) {
      yield value
    }
  }

  override get size(): number {
    let count = this.base.size
    for (const key of this.corrections.keys()) {
      if (!this.base.has(key)) {
        count++
      }
    }
    return count
  }
}

export class JournalDisplaySet<T> extends Set<T> {
  constructor(
    private readonly base: ReadonlySet<T>,
    private readonly additions: ReadonlyMap<T, unknown>
  ) {
    super()
  }

  override has(key: T): boolean {
    return this.base.has(key) || this.additions.has(key)
  }

  override *values(): SetIterator<T> {
    yield* this.base
    for (const key of this.additions.keys()) {
      if (!this.base.has(key)) {
        yield key
      }
    }
  }

  override get size(): number {
    let count = this.base.size
    for (const key of this.additions.keys()) {
      if (!this.base.has(key)) {
        count++
      }
    }
    return count
  }

  override keys() {
    return this.values()
  }

  override *entries(): SetIterator<[T, T]> {
    for (const key of this) {
      yield [key, key]
    }
  }

  override [Symbol.iterator]() {
    return this.values()
  }
}
