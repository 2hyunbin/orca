import type { AppState } from '../../../types'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import type { WorktreePurgeTarget } from '../../worktree-helpers'
import { worktreePurgeClosedFileIds } from './worktree-purge-closed-files'
import { buildWorktreePurgeState } from './worktree-purge-state'
import { noticeRemovedUnsavedFiles } from './removed-workspace-unsaved-files'
import { isUnsavedRemovalConfirmed } from './confirmed-unsaved-removal-scope'

export function buildAnnouncedRemovalPurgeState(
  s: AppState,
  targets: readonly WorktreePurgeTarget[]
): Partial<AppState> {
  const unconfirmed = targets.filter((t) => !isUnsavedRemovalConfirmed(t.hostId, t.id))
  const allClosed = worktreePurgeClosedFileIds(s, targets)
  const eligible = worktreePurgeClosedFileIds(s, unconfirmed)
  // Confirmed views also close, so last-view detection must see the entire batch.
  const noticeState = {
    ...s,
    openFiles: s.openFiles.filter((f) => eligible.has(f.id) || !allClosed.has(f.id))
  }
  noticeRemovedUnsavedFiles(noticeState, eligible)
  return buildWorktreePurgeState(
    s,
    targets.map((t) => (t.hostId ? hostWorktreeTarget({ id: t.id, hostId: t.hostId }) : t.id)),
    { unsavedNoticeHandled: true }
  )
}
