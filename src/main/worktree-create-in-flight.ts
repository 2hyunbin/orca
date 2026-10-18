import { areWorktreePathsEqual } from './git/worktree-path-comparison'

type InFlightWorktreeCreate = { repoId: string; worktreePath: string }

const inFlightCreates = new Set<InFlightWorktreeCreate>()

/**
 * Keeps a checkout out of listings from `git worktree add` until its metadata is persisted.
 *
 * Why: a watcher-driven listing mid-checkout would show it as a bare external row (no CLI or
 * creator provenance), so filters like "Hide CLI-created" let it flash in the sidebar.
 */
export function holdInFlightWorktreeCreate(repoId: string, worktreePath: string): () => void {
  const entry: InFlightWorktreeCreate = { repoId, worktreePath }
  inFlightCreates.add(entry)
  return () => {
    inFlightCreates.delete(entry)
  }
}

export function withoutInFlightWorktreeCreates<T extends { path: string }>(
  repoId: string,
  rows: T[]
): T[] {
  if (inFlightCreates.size === 0) {
    return rows
  }
  const held = [...inFlightCreates].filter((entry) => entry.repoId === repoId)
  if (held.length === 0) {
    return rows
  }
  return rows.filter(
    (row) => !held.some((entry) => areWorktreePathsEqual(row.path, entry.worktreePath))
  )
}
