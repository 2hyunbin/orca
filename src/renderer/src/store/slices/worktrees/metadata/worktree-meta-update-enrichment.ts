import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { displayNameUpdatePinsLabel } from '../../../../../../shared/worktree/display-name-provenance'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'

/** A metadata update as the store applies it (`enriched`), and before its rename and activity
 *  bookkeeping (`targetEnriched`). */
export function enrichWorktreeMetaUpdates(
  updates: Partial<WorktreeMeta>,
  pushTarget: { resolved: WorktreeMeta['pushTarget'] | undefined; clearStale: boolean }
) {
  // Why: bump lastActivityAt on comment edits so the time-decay sort doesn't drop a just-touched worktree.
  const displayNameProvenance =
    'displayName' in updates
      ? { displayNameIsPinned: displayNameUpdatePinsLabel(updates.displayName) }
      : {}
  const targetEnriched = pushTarget.resolved
    ? { ...updates, ...displayNameProvenance, pushTarget: pushTarget.resolved }
    : pushTarget.clearStale
      ? { ...updates, ...displayNameProvenance, pushTarget: undefined }
      : { ...updates, ...displayNameProvenance }
  const renameCleared =
    'displayName' in targetEnriched
      ? {
          ...targetEnriched,
          pendingFirstAgentMessageRename: false,
          firstAgentMessageRenameError: null
        }
      : targetEnriched
  // Switch point: a comment edit is not a Recent event once the host owns the stamps.
  const enriched =
    'comment' in renameCleared && !ORCA_SIDEBAR_INPUTS_IS_MAIN
      ? { ...renameCleared, lastActivityAt: Date.now() }
      : renameCleared
  return { targetEnriched, enriched }
}
