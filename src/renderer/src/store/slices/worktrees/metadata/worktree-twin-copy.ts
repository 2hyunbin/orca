import type { Worktree } from '../../../../../../shared/worktree/types'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../../../shared/workspace-attachments'
import { CLEARED_HOSTED_REVIEW_LINK_UPDATES } from '../../../../../../shared/worktree/hosted-review-links'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'

/** One copy's owner: its host plus the paired server that published it (two can share an `ssh:` id). */
export function worktreeCopyOwnerKey(
  row: Partial<Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>>
): string {
  return `${row.hostId ?? ''}\0${row.runtimeOwnerEnvironmentId ?? ''}`
}

/** Clears branch-scoped review context on the one twin copy `owner` names. */
export function clearTwinCopyReviewLinks(
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
