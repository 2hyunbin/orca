import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { applyWorktreeUpdates } from '../worktree-helpers'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById,
  folderWorkspaceMatchesHost
} from '../worktrees/listing/detected-worktree-meta'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import { persistPassiveWorktreeMetaForOwner } from '../worktrees/listing/worktree-owner-settings'
import type { WorkspaceAttentionGet, WorkspaceAttentionSet } from './workspace-attention-contract'
import { workspaceHasLiveMarker } from './workspace-live-markers'

// The persisted workspace flag `isUnread`. Only the workspace-attention module writes it.

export function markWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string
): void {
  const now = Date.now()
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspaceId = workspaceScope.folderWorkspaceId
    let shouldPersist = false
    set((s) => {
      const folderWorkspace = s.folderWorkspaces.find(
        (workspace) => workspace.id === folderWorkspaceId
      )
      if (!folderWorkspace || folderWorkspace.isUnread) {
        return s
      }
      shouldPersist = true
      return {
        folderWorkspaces: s.folderWorkspaces.map((workspace) =>
          workspace.id === folderWorkspaceId
            ? { ...workspace, isUnread: true, lastActivityAt: now }
            : workspace
        ),
        sortEpoch: s.sortEpoch + 1
      }
    })
    if (!shouldPersist) {
      return
    }
    void get().updateFolderWorkspace(folderWorkspaceId, {
      isUnread: true,
      lastActivityAt: now
    })
    return
  }
  let shouldPersist = false
  set((s) => {
    const worktree = findKnownWorktreeById(s, worktreeId)
    if (!worktree || worktree.isUnread) {
      return s
    }
    shouldPersist = true
    const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
      isUnread: true,
      lastActivityAt: now
    })
    const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
      s.detectedWorktreesByRepo,
      worktreeId,
      {
        isUnread: true,
        lastActivityAt: now
      }
    )
    return {
      ...(nextWorktrees !== s.worktreesByRepo
        ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
        : {}),
      ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
        ? { detectedWorktreesByRepo: nextDetectedWorktrees }
        : {})
    }
  })

  if (!shouldPersist) {
    return
  }

  persistPassiveWorktreeMetaForOwner(
    get,
    worktreeId,
    { isUnread: true, lastActivityAt: now },
    'persist unread worktree state'
  )
}

export function clearWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string,
  /** Folder rows share an id across hosts; when known, only that host's row is read. */
  executionHostId?: ExecutionHostId | null
): void {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspaceId = workspaceScope.folderWorkspaceId
    const isTarget = (workspace: FolderWorkspace): boolean =>
      workspace.id === folderWorkspaceId &&
      (!executionHostId || folderWorkspaceMatchesHost(workspace, executionHostId))
    if (!get().folderWorkspaces.find(isTarget)?.isUnread) {
      return
    }
    // Why: flip locally first so repeated reads dedupe on the guard above before the IPC round-trip lands.
    set((s) => ({
      folderWorkspaces: s.folderWorkspaces.map((workspace) =>
        isTarget(workspace) ? { ...workspace, isUnread: false } : workspace
      )
    }))
    if (executionHostId) {
      void get().updateFolderWorkspace(folderWorkspaceId, { isUnread: false }, { executionHostId })
    } else {
      void get().updateFolderWorkspace(folderWorkspaceId, { isUnread: false })
    }
    return
  }
  let shouldPersist = false
  set((s) => {
    const worktree = findKnownWorktreeById(s, worktreeId)
    if (!worktree || !worktree.isUnread) {
      // Why: return `s` (not {}) to keep the object reference on a no-op, avoiding selector churn.
      return s
    }
    shouldPersist = true
    const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
      isUnread: false
    })
    const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
      s.detectedWorktreesByRepo,
      worktreeId,
      {
        isUnread: false
      }
    )
    return {
      ...(nextWorktrees !== s.worktreesByRepo ? { worktreesByRepo: nextWorktrees } : {}),
      ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
        ? { detectedWorktreesByRepo: nextDetectedWorktrees }
        : {})
    }
  })

  if (!shouldPersist) {
    return
  }

  persistPassiveWorktreeMetaForOwner(
    get,
    worktreeId,
    { isUnread: false },
    'persist cleared unread worktree state'
  )
}

/** The flag follows its markers — a read or removal clears it once no live marker remains. */
export function settleWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): void {
  // Why only downward: raising here would override another client's Mark as read with this
  // renderer's local markers; marking already raises the flag together with its marker.
  if (!workspaceHasLiveMarker(get(), worktreeId)) {
    clearWorkspaceUnreadFlag(set, get, worktreeId, executionHostId)
  }
}

/** The flag {@link clearWorkspaceUnreadFlag} would clear. */
export function isWorkspaceFlagSet(
  state: Parameters<typeof findKnownWorktreeById>[0],
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): boolean {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return Boolean(
      state.folderWorkspaces.find(
        (workspace) =>
          workspace.id === workspaceScope.folderWorkspaceId &&
          (!executionHostId || folderWorkspaceMatchesHost(workspace, executionHostId))
      )?.isUnread
    )
  }
  return Boolean(findKnownWorktreeById(state, worktreeId)?.isUnread)
}
