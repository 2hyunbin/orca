import { JournalMutationMap } from './journal-mutation-map'

class SetMembers<T> extends Map<T, true> {
  constructor(private readonly source: ReadonlySet<T>) {
    super()
  }

  override has(key: T): boolean {
    return this.source.has(key)
  }

  override get(key: T): true | undefined {
    return this.source.has(key) ? true : undefined
  }

  override *entries(): MapIterator<[T, true]> {
    for (const key of this.source) {
      yield [key, true]
    }
  }

  override [Symbol.iterator]() {
    return this.entries()
  }

  override get size(): number {
    return this.source.size
  }
}

export class JournalMutationSet<T> extends Set<T> {
  private readonly members: JournalMutationMap<T, true>

  constructor(base: ReadonlySet<T>) {
    super()
    this.members = new JournalMutationMap(new SetMembers(base))
  }

  override add(key: T): this {
    this.members.set(key, true)
    return this
  }

  override delete(key: T): boolean {
    return this.members.delete(key)
  }

  override has(key: T): boolean {
    return this.members.has(key)
  }

  override values() {
    return this.members.keys()
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

  override get size(): number {
    return this.members.size
  }
}
