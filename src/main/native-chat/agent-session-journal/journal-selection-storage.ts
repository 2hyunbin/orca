import { JournalMutationMap } from './journal-mutation-map'
import type { JournalStructuralStorage } from './journal-rest-projection-index'

/** Namespaces contain immutable records; a fork materializes only touched namespaces/keys. */
export class JournalSelectionStorage {
  private readonly spaces = new Map<string, Map<unknown, unknown>>()
  constructor(
    private readonly disk?: JournalStructuralStorage,
    private readonly parent?: JournalSelectionStorage
  ) {}

  map<K, V>(name: string): Map<K, V> {
    if (this.disk) {
      return this.disk.map(`selection:${name}`)
    }
    let rows = this.spaces.get(name)
    if (!rows) {
      const inherited = this.parent?.existing(name)
      rows = inherited ? new JournalMutationMap(inherited) : new Map()
      this.spaces.set(name, rows)
    }
    // SAFETY: each concrete namespace has one key/value type at its sole owning endpoint.
    return rows as Map<K, V>
  }

  private existing(name: string): Map<unknown, unknown> | undefined {
    return (
      this.disk?.map(`selection:${name}`) ?? this.spaces.get(name) ?? this.parent?.existing(name)
    )
  }

  fork(): JournalSelectionStorage {
    return new JournalSelectionStorage(undefined, this)
  }
}
