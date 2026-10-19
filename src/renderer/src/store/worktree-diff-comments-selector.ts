import type { DiffComment } from '../../../shared/diff-comment-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppState } from './types'
import { getIndexedWorktreeById } from './worktree-repo-index'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { namedHostForOwnerRef } from '@/lib/resolve-owner'
import { worktreeMatchesHost } from './slices/worktrees/listing/worktree-host-ownership'
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

/** One worktree on one host; `worktrees` holds every row a listing race duplicated for it. */
export type DiffCommentCopy = { executionHostId: ExecutionHostId; worktrees: readonly Worktree[] }

function copyHostId(row: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>): ExecutionHostId {
  const environmentId = row.runtimeOwnerEnvironmentId?.trim()
  return environmentId
    ? toRuntimeExecutionHostId(environmentId)
    : (parseExecutionHostId(row.hostId)?.id ?? LOCAL_EXECUTION_HOST_ID)
}

function onlyCopy(copies: readonly DiffCommentCopy[]): DiffCommentCopy | null {
  return copies.length === 1 ? copies[0] : null
}

/**
 * The copy of a git worktree whose review notes a change reads or writes. The same id on two hosts
 * is a twin, picked by, in order: the host a queued write captured; the one copy holding the notes
 * the change names (UUIDs, so an async delivery still finds its copy after navigation); the open
 * workspace's host. Nothing else guesses.
 */
export function findDiffCommentCopy(
  state: Pick<
    DiffCommentSelectorState,
    'worktreesByRepo' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  worktreeId: string,
  hint: { executionHostId?: ExecutionHostId; commentIds?: ReadonlySet<string> } = {}
): DiffCommentCopy | null {
  const byHost = new Map<ExecutionHostId, Worktree[]>()
  for (const row of state.worktreesByRepo[getRepoIdFromWorktreeId(worktreeId)] ?? []) {
    if (row.id === worktreeId) {
      const hostId = copyHostId(row)
      byHost.set(hostId, [...(byHost.get(hostId) ?? []), row])
    }
  }
  const copies = [...byHost].map(([executionHostId, worktrees]) => ({ executionHostId, worktrees }))
  if (hint.executionHostId) {
    return copies.find((copy) => copy.executionHostId === hint.executionHostId) ?? null
  }
  if (copies.length <= 1) {
    return copies[0] ?? null
  }
  const { commentIds } = hint
  const holder = commentIds?.size
    ? onlyCopy(
        copies.filter((copy) =>
          copy.worktrees[0].diffComments?.some((comment) => commentIds.has(comment.id))
        )
      )
    : null
  if (holder) {
    return holder
  }
  const named = namedHostForOwnerRef(state, { workspaceId: worktreeId })
  return named
    ? onlyCopy(copies.filter((copy) => worktreeMatchesHost(copy.worktrees[0], named)))
    : null
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
  // Mounted surfaces rerun this on every store write, so only the open workspace scans its bucket;
  // the rest share the immutable-snapshot id index.
  const open = namedHostForOwnerRef(state, { workspaceId: worktreeId })
    ? findDiffCommentCopy(state, worktreeId)?.worktrees[0]
    : undefined
  return (open ?? getIndexedWorktreeById(state.worktreesByRepo, worktreeId))?.diffComments
}

export function selectWorktreeDiffCommentsOrEmpty(
  state: Parameters<typeof selectWorktreeDiffComments>[0],
  worktreeId: string | null | undefined
): DiffComment[] {
  return selectWorktreeDiffComments(state, worktreeId) ?? EMPTY_DIFF_COMMENTS
}
