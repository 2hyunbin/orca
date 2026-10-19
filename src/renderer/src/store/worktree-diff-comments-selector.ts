import type { DiffComment } from '../../../shared/diff-comment-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppState } from './types'
import { getIndexedWorktreeById } from './worktree-repo-index'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { namedHostForOwnerRef } from '@/lib/resolve-owner'
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
 * The host a row's notes are written through: its own stamp, except that a paired server's row
 * stamped `local` (or not at all) is local to that server. `undefined` leaves the owner to the
 * route resolvers, as for any unstamped row.
 */
function copyHostId(
  row: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>
): ExecutionHostId | undefined {
  const environmentId = row.runtimeOwnerEnvironmentId?.trim()
  return environmentId && (!row.hostId || row.hostId === LOCAL_EXECUTION_HOST_ID)
    ? toRuntimeExecutionHostId(environmentId)
    : row.hostId
}

/**
 * One copy of a worktree: the rows on one host (a listing race can duplicate a row), keyed by the
 * store's host-qualified identity. An unstamped row is its own copy.
 */
export type DiffCommentCopy = {
  key: HostScopedWorktreeKey
  hostId?: ExecutionHostId
  worktrees: readonly Worktree[]
}

function onlyCopy(copies: readonly DiffCommentCopy[]): DiffCommentCopy | null {
  return copies.length === 1 ? copies[0] : null
}

/**
 * The copy of a worktree whose review notes a change reads or writes. The same id on two hosts is
 * a twin, picked by, in order: the copy a queued write captured; the one copy holding the notes the
 * change names (UUIDs, so an async delivery still finds its copy after navigation); the open
 * workspace's host. Nothing else guesses.
 */
export function findDiffCommentCopy(
  state: Pick<
    DiffCommentSelectorState,
    'worktreesByRepo' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  worktreeId: string,
  hint: { key?: HostScopedWorktreeKey; commentIds?: ReadonlySet<string> } = {}
): DiffCommentCopy | null {
  const byKey = new Map<HostScopedWorktreeKey, DiffCommentCopy>()
  for (const row of state.worktreesByRepo[getRepoIdFromWorktreeId(worktreeId)] ?? []) {
    if (row.id !== worktreeId) {
      continue
    }
    const hostId = copyHostId(row)
    const key = composeWorktreeHostIdentity(hostId, worktreeId)
    byKey.set(key, {
      key,
      ...(hostId ? { hostId } : {}),
      worktrees: [...(byKey.get(key)?.worktrees ?? []), row]
    })
  }
  const copies = [...byKey.values()]
  if (hint.key) {
    return byKey.get(hint.key) ?? null
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
  // Why both: the selection names a row's own stamp, which a paired server's row may not route by.
  return named
    ? onlyCopy(
        copies.filter(
          (copy) => copy.hostId === named || copy.worktrees.some((row) => row.hostId === named)
        )
      )
    : null
}

/** The list a change naming these notes would edit; see {@link findDiffCommentCopy}. */
export function readDiffCommentsForChange(
  state: DiffCommentSelectorState,
  worktreeId: string,
  commentIds: Iterable<string>
): DiffComment[] {
  const scope = parseWorkspaceKey(worktreeId)
  const list =
    scope?.type === 'folder'
      ? findFolderWorkspaceOwner(state, scope.folderWorkspaceId)?.diffComments
      : findDiffCommentCopy(state, worktreeId, { commentIds: new Set(commentIds) })?.worktrees[0]
          .diffComments
  return list ?? []
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
