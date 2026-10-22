/**
 * Unsaved editor drafts of a moved project. The manifest never carries them (drafts stay on this
 * desktop), so the host partition's seed has each drafted file without its contents. This lays
 * the desktop's own draft over the seeded record, as the SSH move's draft rename does.
 */
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isHostBoundOpenFile } from '../migrating-orcad-catalog/orcad-source-draft-rename'
import type { WslMoveRewriteScope } from './wsl-move-rewrite-scope'

/** `seed` with the local drafts of `seededWorkspaceIds` laid over it; null when none applies. */
export function withWslMoveSeededDrafts(
  seed: WorkspaceSessionState,
  local: Pick<WorkspaceSessionState, 'openFilesByWorktree'>,
  scope: Pick<WslMoveRewriteScope, 'inScope' | 'worktreeId' | 'path'>,
  seededWorkspaceIds: ReadonlySet<string>
): WorkspaceSessionState | null {
  const openFilesByWorktree = { ...seed.openFilesByWorktree }
  let changed = false
  for (const [owner, files] of Object.entries(local.openFilesByWorktree ?? {})) {
    if (!scope.inScope(owner)) {
      continue
    }
    const hostKey = scope.worktreeId(owner)
    // Only workspaces this run seeds: a file the user since closed on the host stays closed.
    if (!seededWorkspaceIds.has(hostKey)) {
      continue
    }
    for (const file of files) {
      if (file.dirtyDraftContent === undefined || isHostBoundOpenFile(file)) {
        continue
      }
      const hostPath = scope.path(file.filePath)
      const held = openFilesByWorktree[hostKey] ?? []
      const index = held.findIndex(
        (entry) => entry.filePath === hostPath && entry.dirtyDraftContent === undefined
      )
      if (index === -1) {
        continue
      }
      const next = [...held]
      next[index] = {
        ...held[index],
        dirtyDraftContent: file.dirtyDraftContent,
        ...(file.lastKnownDiskSignature !== undefined
          ? { lastKnownDiskSignature: file.lastKnownDiskSignature }
          : {})
      }
      openFilesByWorktree[hostKey] = next
      changed = true
    }
  }
  return changed ? { ...seed, openFilesByWorktree } : null
}
