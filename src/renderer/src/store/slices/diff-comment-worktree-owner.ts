import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from './worktree-helpers'
import { namedHostForOwnerRef } from '@/lib/resolve-owner'
import {
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost,
  resolveIndexedWorktreeOwner
} from '@/lib/worktree-runtime-owner-index'

/**
 * The git worktree row a diff-comment change targets. The same id on two hosts is a twin: only the
 * host named by the caller or the open workspace picks one, and `lenient` reads fall back to the
 * first copy as before.
 */
export function findDiffCommentWorktree(
  state: Pick<AppState, 'worktreesByRepo' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>,
  worktreeId: string,
  options: { executionHostId?: ExecutionHostId; lenient?: boolean } = {}
): { worktree: Worktree; executionHostId?: ExecutionHostId } | null {
  const rows = state.worktreesByRepo[getRepoIdFromWorktreeId(worktreeId)] ?? []
  const named =
    options.executionHostId ?? namedHostForOwnerRef(state, { workspaceId: worktreeId }) ?? undefined
  if (resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId).kind !== 'ambiguous') {
    const owner = findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
    const worktree = rows.find((row) => row === owner)
    // Why no host: a unique row keeps the id-only write path, and one queue key per row.
    return worktree ? { worktree } : null
  }
  const owner = named
    ? findIndexedWorktreeOwnerForHost(state.worktreesByRepo, worktreeId, named)
    : null
  const worktree = rows.find((row) => row === owner)
  if (worktree && named) {
    return { worktree, executionHostId: named }
  }
  const first = options.lenient ? rows.find((row) => row.id === worktreeId) : undefined
  return first ? { worktree: first } : null
}
