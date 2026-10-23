/** Only touched entries belong to a mutation; the published fold remains unchanged until COMMIT. */
export class JournalMutationMap<K, V> extends Map<K, V> {
  private readonly removed = new Set<K>()
  constructor(
    private readonly base: ReadonlyMap<K, V>,
    private readonly copy?: (value: V) => V
  ) {
    super()
  }
  override has(key: K): boolean {
    return !this.removed.has(key) && (super.has(key) || this.base.has(key))
  }
  override get(key: K): V | undefined {
    if (this.removed.has(key)) {
      return undefined
    }
    if (super.has(key)) {
      return super.get(key)
    }
    const value = this.base.get(key)
    if (value === undefined || !this.copy) {
      return value
    }
    const copied = this.copy(value)
    super.set(key, copied)
    return copied
  }
  override set(key: K, value: V): this {
    this.removed.delete(key)
    return super.set(key, value)
  }
  override delete(key: K): boolean {
    const existed = this.has(key)
    super.delete(key)
    this.removed.add(key)
    return existed
  }
  override *entries(): MapIterator<[K, V]> {
    for (const [key, value] of this.base) {
      if (!this.removed.has(key)) {
        yield [key, this.get(key) ?? value]
      }
    }
    for (const entry of super.entries()) {
      if (!this.base.has(entry[0])) {
        yield entry
      }
    }
  }
  override [Symbol.iterator]() {
    return this.entries()
  }
  override *values() {
    for (const [, value] of this.entries()) {
      yield value
    }
  }
  override *keys() {
    for (const [key] of this.entries()) {
      yield key
    }
  }
  override get size(): number {
    let size = this.base.size
    for (const key of this.removed) {
      if (this.base.has(key)) {
        size--
      }
    }
    for (const key of super.keys()) {
      if (!this.base.has(key)) {
        size++
      }
    }
    return size
  }
}
