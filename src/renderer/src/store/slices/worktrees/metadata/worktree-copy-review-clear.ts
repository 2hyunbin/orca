import type { Worktree } from '../../../../../../shared/worktree/types'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../../../shared/workspace-attachments'
import { CLEARED_HOSTED_REVIEW_LINK_UPDATES } from '../../../../../../shared/worktree/hosted-review-links'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'

// Why this module: worktree ids repeat across hosts (`repoId::path`), so branch-switch review
// clears are keyed by id plus the copy's owner and never by the bare id.

/** One copy's owner: its host plus the paired server that published it (two can share an `ssh:` id). */
export function worktreeCopyOwnerKey(
  row: Partial<Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>>
): string {
  return `${row.hostId ?? ''}\0${row.runtimeOwnerEnvironmentId ?? ''}`
}

/** Clears branch-scoped review context on the one copy `owner` names. */
export function clearCopyReviewLinks(
  byRepo: Record<string, Worktree[]>,
  worktreeId: string,
  owner: string
): Record<string, Worktree[]> {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  let changed = false
  const next = byRepo[repoId]?.map((row) => {
    if (row.id !== worktreeId || worktreeCopyOwnerKey(row) !== owner) {
      return row
    }
    changed = true
    return {
      ...row,
      ...normalizeWorkspaceAttachmentUpdate(row, CLEARED_HOSTED_REVIEW_LINK_UPDATES)
    }
  })
  return changed && next ? { ...byRepo, [repoId]: next } : byRepo
}

export function reviewClearTombstoneKey(worktreeId: string, owner: string): string {
  return `${worktreeId}\0${owner}`
}

/** Drops every copy's tombstone for `worktreeId`. */
export function deleteCopyTombstones(tombstones: Map<string, unknown>, worktreeId: string): void {
  for (const key of Array.from(tombstones.keys())) {
    if (key === worktreeId || key.startsWith(`${worktreeId}\0`)) {
      tombstones.delete(key)
    }
  }
}

/** Re-keys every copy's tombstone after a rename; true when any moved. */
export function moveCopyTombstones<T>(
  tombstones: Map<string, T>,
  oldWorktreeId: string,
  newWorktreeId: string
): boolean {
  const prefix = `${oldWorktreeId}\0`
  let moved = false
  for (const [key, tombstone] of Array.from(tombstones)) {
    if (key.startsWith(prefix)) {
      tombstones.set(`${newWorktreeId}\0${key.slice(prefix.length)}`, tombstone)
      tombstones.delete(key)
      moved = true
    }
  }
  return moved
}
