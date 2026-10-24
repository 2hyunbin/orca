import type { JournalSelectionStorage } from './journal-selection-storage'
import { JournalSelectionTree, type SelectionCandidate } from './journal-selection-tree'

type Header = { count: number; next: number; revision: number }

/** Ordered, incremental memberships; point touches never copy a retained cohort. */
export class JournalSelectionGroups {
  private readonly members: Map<string, number>
  private readonly headers: Map<string, Header>
  private readonly tree: JournalSelectionTree
  constructor(storage: JournalSelectionStorage) {
    this.members = storage.map('groupMembers')
    this.headers = storage.map('groupHeaders')
    this.tree = new JournalSelectionTree(storage)
  }

  private key(group: string, member: string): string {
    return JSON.stringify([group, member])
  }

  has(group: string, member?: string): boolean {
    return member === undefined
      ? (this.headers.get(group)?.count ?? 0) !== 0
      : this.members.has(this.key(group, member))
  }

  revision(group: string): number {
    return this.headers.get(group)?.revision ?? 0
  }

  touch(group: string): void {
    const old = this.headers.get(group) ?? { count: 0, next: 0, revision: 0 }
    this.headers.set(group, { ...old, revision: old.revision + 1 })
  }

  update(group: string, member: string, present: boolean, ordinal?: number): void {
    const address = this.key(group, member)
    const previous = this.members.get(address)
    if ((previous !== undefined) === present) {
      return
    }
    const old = this.headers.get(group) ?? { count: 0, next: 0, revision: 0 }
    const order = ordinal ?? old.next + 1
    this.headers.set(group, {
      count: old.count + (present ? 1 : -1),
      next: present ? Math.max(old.next, order) : old.next,
      revision: old.revision + 1
    })
    if (present) {
      this.members.set(address, order)
      this.tree.update(`group:${group}`, member, {
        key: member,
        rank: order,
        ordinal: order,
        time: order
      })
    } else {
      this.members.delete(address)
      this.tree.update(`group:${group}`, member, undefined)
    }
  }

  releaseEmpty(group: string): void {
    if (!this.has(group)) {
      this.headers.delete(group)
    }
  }

  next(group: string, after?: SelectionCandidate): SelectionCandidate | undefined {
    return this.tree.next(`group:${group}`, after)
  }

  *values(group: string): IterableIterator<string> {
    let cursor: SelectionCandidate | undefined
    for (;;) {
      const next = this.next(group, cursor)
      if (!next) {
        return
      }
      cursor = next
      yield next.key
    }
  }
}
