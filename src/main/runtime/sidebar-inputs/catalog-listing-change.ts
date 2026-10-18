import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

/** One listing, as the window's catalog would hold it: each row's fields apart from sortOrder. */
export type CatalogListing = ReadonlyMap<string, { row: string; sortOrder: number }>

// Fields main's listing carries that the window's catalog rows do not.
const MAIN_ONLY_FIELDS = new Set([
  'sortOrder',
  'git',
  'lineage',
  'parentWorktreeId',
  'childWorktreeIds'
])

export function indexCatalogListing(worktrees: readonly Worktree[]): CatalogListing {
  return new Map(
    worktrees.map((worktree) => [
      getWorktreeHostIdentity(worktree),
      {
        row: JSON.stringify(worktree, (key, value: unknown) =>
          MAIN_ONLY_FIELDS.has(key) ? undefined : value
        ),
        sortOrder: worktree.sortOrder
      }
    ])
  )
}

/**
 * How the window's catalog merge would read a new listing: a row change bumps its sort, a save
 * that only moved sortOrder does not (#27268), and an identical listing writes nothing.
 */
export function classifyCatalogListingChange(
  previous: CatalogListing,
  next: CatalogListing
): 'none' | 'sort-order' | 'rows' {
  if (previous.size !== next.size) {
    return 'rows'
  }
  let sortOrderMoved = false
  for (const [identity, entry] of next) {
    const before = previous.get(identity)
    if (before?.row !== entry.row) {
      return 'rows'
    }
    sortOrderMoved ||= before.sortOrder !== entry.sortOrder
  }
  return sortOrderMoved ? 'sort-order' : 'none'
}

export function countLiveRows(worktrees: readonly Worktree[]): number {
  return worktrees.filter((worktree) => !worktree.isArchived).length
}
