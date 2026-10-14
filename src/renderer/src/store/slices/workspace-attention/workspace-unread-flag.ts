import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { AppState } from '../../types'
import { applyWorktreeUpdates } from '../worktree-helpers'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById,
  folderWorkspaceMatchesHost
} from '../worktrees/listing/detected-worktree-meta'
import { persistPassiveWorktreeMetaForOwner } from '../worktrees/listing/worktree-owner-settings'
import type { WorkspaceAttentionGet, WorkspaceAttentionSet } from './workspace-attention-contract'

// The persisted workspace flag `isUnread`. Only the workspace-attention module writes it.

export function markWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string
): void {
  // Why: attention dot stays until the user engages the worktree; cleared by pane interaction or activation.
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
  worktreeId: string
): void {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspaceId = workspaceScope.folderWorkspaceId
    const folderWorkspace = get().folderWorkspaces.find(
      (workspace) => workspace.id === folderWorkspaceId
    )
    if (!folderWorkspace?.isUnread) {
      return
    }
    // Why: flip locally first — this runs per keystroke, so the guard above must dedupe before the IPC round-trip lands.
    set((s) => ({
      folderWorkspaces: s.folderWorkspaces.map((workspace) =>
        workspace.id === folderWorkspaceId ? { ...workspace, isUnread: false } : workspace
      )
    }))
    void get().updateFolderWorkspace(folderWorkspaceId, { isUnread: false })
    return
  }
  let shouldPersist = false
  set((s) => {
    const worktree = findKnownWorktreeById(s, worktreeId)
    if (!worktree || !worktree.isUnread) {
      // Why: return `s` (not {}) to keep the object reference on this hot-path no-op (every keystroke), avoiding selector churn.
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

export type WorkspaceActivationReadPatch = Pick<
  AppState,
  'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces'
>

/**
 * Activating a workspace reads its flag: every worktree row with the id, or the folder rows on the
 * activated host. Pure, so activation folds it into its own `set()`; markers are left alone; null
 * when the activated row is not unread.
 * Why no lastActivityAt: focus isn't smart-sort activity — writing it caused the "jump after focus" bug.
 */
export function readWorkspaceFlagOnActivation(
  s: WorkspaceActivationReadPatch,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  activatedRow: { isUnread?: boolean } | undefined
): WorkspaceActivationReadPatch | null {
  if (!activatedRow?.isUnread) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  return {
    worktreesByRepo: applyWorktreeUpdates(s.worktreesByRepo, worktreeId, { isUnread: false }),
    detectedWorktreesByRepo: applyDetectedWorktreeUpdates(s.detectedWorktreesByRepo, worktreeId, {
      isUnread: false
    }),
    folderWorkspaces:
      workspaceScope?.type === 'folder'
        ? s.folderWorkspaces.map((workspace) =>
            workspace.id === workspaceScope.folderWorkspaceId &&
            (!executionHostId || folderWorkspaceMatchesHost(workspace, executionHostId))
              ? { ...workspace, isUnread: false }
              : workspace
          )
        : s.folderWorkspaces
  }
}

/** Persists the read that {@link readWorkspaceFlagOnActivation} applied. */
export function persistWorkspaceReadOnActivation(
  get: WorkspaceAttentionGet,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): void {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    void get().updateFolderWorkspace(
      workspaceScope.folderWorkspaceId,
      { isUnread: false },
      executionHostId ? { executionHostId } : undefined
    )
    return
  }
  persistPassiveWorktreeMetaForOwner(
    get,
    worktreeId,
    { isUnread: false },
    'persist worktree activation state'
  )
}
