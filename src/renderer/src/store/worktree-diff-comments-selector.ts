import type { DiffComment } from '../../../shared/diff-comment-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  type HostScopedWorktreeKey
} from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppState } from './types'
import { getIndexedWorktreeById } from './worktree-repo-index'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { namedHostForOwnerRef } from '@/lib/resolve-owner'
import { findIndexedWorktreeOwnerForHost } from '@/lib/worktree-runtime-owner-index'
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
 * The host a row's notes are written through: a paired server's row goes through that server
 * (rival servers may stamp the same SSH target), else its own stamp. `undefined` leaves the owner
 * to the route resolvers, as for any unstamped row.
 */
function copyHostId(
  row: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>
): ExecutionHostId | undefined {
  const environmentId = row.runtimeOwnerEnvironmentId?.trim()
  return environmentId ? toRuntimeExecutionHostId(environmentId) : row.hostId
}

/** Same copy, allowing an unstamped row that a listing has since stamped `local`. */
export function isSameDiffCommentCopy(
  a: HostScopedWorktreeKey | undefined,
  b: HostScopedWorktreeKey | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  const worktreeId = getWorktreeIdFromHostIdentity(a)
  const unstamped = composeWorktreeHostIdentity(undefined, worktreeId)
  const local = composeWorktreeHostIdentity(LOCAL_EXECUTION_HOST_ID, worktreeId)
  return (a === unstamped && b === local) || (a === local && b === unstamped)
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

function diffCommentCopyNotesOrUndefined(copy: DiffCommentCopy | null): DiffComment[] | undefined {
  return copy ? diffCommentCopyNotes(copy) : undefined
}

/** The copy's notes; the last duplicate wins, as in the id index the rest of the app reads. */
export function diffCommentCopyNotes(copy: DiffCommentCopy): DiffComment[] | undefined {
  return copy.worktrees.at(-1)?.diffComments
}

/**
 * The copy of a worktree whose review notes a change reads or writes. The same id on two hosts is
 * a twin, picked by, in order: the copy a queued write captured; the one copy holding the notes the
 * change names (UUIDs, so an async delivery still finds its copy after navigation); the open
 * workspace's host, read with the owner index's host semantics; else the only copy. A named host
 * no copy matches is a refusal, never the remaining copy.
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
    // Why: a listing refresh may stamp an unstamped row mid-queue; that is still the same row.
    const unstamped = hint.key === composeWorktreeHostIdentity(undefined, worktreeId)
    return byKey.get(hint.key) ?? (unstamped ? onlyCopy(copies) : null)
  }
  const { commentIds } = hint
  const holder = commentIds?.size
    ? onlyCopy(
        copies.filter((copy) =>
          diffCommentCopyNotes(copy)?.some((comment) => commentIds.has(comment.id))
        )
      )
    : null
  if (holder) {
    return holder
  }
  const named = namedHostForOwnerRef(state, { workspaceId: worktreeId })
  // Why: a lone unstamped row has unknown provenance, not another host's; the resolvers place it.
  if (!named || (copies.length === 1 && !copies[0].hostId)) {
    return onlyCopy(copies)
  }
  const owner = findIndexedWorktreeOwnerForHost(state.worktreesByRepo, worktreeId, named)
  const copy = copies.find((candidate) => candidate.worktrees.some((row) => row === owner))
  // Why: an unstamped row the selection names is on that host; the write says so to main.
  return copy ? { ...copy, hostId: copy.hostId ?? named } : null
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
      : diffCommentCopyNotesOrUndefined(
          findDiffCommentCopy(state, worktreeId, { commentIds: new Set(commentIds) })
        )
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
    ? findDiffCommentCopy(state, worktreeId)
    : null
  return open
    ? diffCommentCopyNotes(open)
    : getIndexedWorktreeById(state.worktreesByRepo, worktreeId)?.diffComments
}

export function selectWorktreeDiffCommentsOrEmpty(
  state: Parameters<typeof selectWorktreeDiffComments>[0],
  worktreeId: string | null | undefined
): DiffComment[] {
  return selectWorktreeDiffComments(state, worktreeId) ?? EMPTY_DIFF_COMMENTS
}
