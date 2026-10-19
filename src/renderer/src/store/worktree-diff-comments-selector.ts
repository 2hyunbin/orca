import type { DiffComment } from '../../../shared/diff-comment-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppState } from './types'
import { getIndexedWorktreeById } from './worktree-repo-index'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { namedHostForOwnerRef } from '@/lib/resolve-owner'
import {
  findIndexedWorktreeOwnerForHost,
  resolveIndexedWorktreeOwner
} from '@/lib/worktree-runtime-owner-index'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

const EMPTY_DIFF_COMMENTS = Object.freeze([]) as unknown as DiffComment[]

type DiffCommentSelectorState = Pick<AppState, 'worktreesByRepo'> &
  Partial<
    Pick<
      AppState,
      | 'activeWorkspaceExecutionHostId'
      | 'activeWorktreeId'
      | 'folderWorkspaces'
      | 'projectGroups'
      | 'restoredRuntimeHostIdByWorkspaceSessionKey'
      | 'runtimeEnvironments'
      | 'settings'
    >
  >

/**
 * The git worktree row whose review notes a change reads or writes. The same id on two hosts is a
 * twin: only `executionHostId`, else the open workspace's host, picks one, and that host travels
 * with the write. A named host the row no longer matches is no row at all.
 */
export function findDiffCommentWorktree(
  state: Pick<
    DiffCommentSelectorState,
    'worktreesByRepo' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): { worktree: Worktree; executionHostId?: ExecutionHostId } | null {
  const rows = state.worktreesByRepo[getRepoIdFromWorktreeId(worktreeId)] ?? []
  const resolution = resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  if (resolution.kind !== 'ambiguous') {
    const owner =
      resolution.kind === 'resolved' &&
      (!executionHostId ||
        findIndexedWorktreeOwnerForHost(state.worktreesByRepo, worktreeId, executionHostId) ===
          resolution.owner)
        ? resolution.owner
        : null
    const worktree = rows.find((row) => row === owner)
    if (!worktree) {
      return null
    }
    // Why no host for an unnamed unique row: it keeps the id-only write and one queue per row.
    return executionHostId ? { worktree, executionHostId } : { worktree }
  }
  const named =
    executionHostId ?? namedHostForOwnerRef(state, { workspaceId: worktreeId }) ?? undefined
  const owner = named
    ? findIndexedWorktreeOwnerForHost(state.worktreesByRepo, worktreeId, named)
    : null
  const worktree = rows.find((row) => row === owner)
  return worktree && named ? { worktree, executionHostId: named } : null
}

export function selectWorktreeDiffComments(
  state: DiffCommentSelectorState,
  worktreeId: string | null | undefined
): DiffComment[] | undefined {
  if (!worktreeId) {
    return undefined
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return findFolderWorkspaceOwner(state, scope.folderWorkspaceId)?.diffComments
  }
  // Why: the open twin's own notes; an unnamed twin still reads its first copy, as writes refuse it.
  // Mounted surfaces rerun this on every store write, so only the open workspace pays the owner
  // index; the rest share the immutable-snapshot id index.
  const open = namedHostForOwnerRef(state, { workspaceId: worktreeId })
    ? findDiffCommentWorktree(state, worktreeId)?.worktree
    : undefined
  return (open ?? getIndexedWorktreeById(state.worktreesByRepo, worktreeId))?.diffComments
}

export function selectWorktreeDiffCommentsOrEmpty(
  state: Parameters<typeof selectWorktreeDiffComments>[0],
  worktreeId: string | null | undefined
): DiffComment[] {
  return selectWorktreeDiffComments(state, worktreeId) ?? EMPTY_DIFF_COMMENTS
}
