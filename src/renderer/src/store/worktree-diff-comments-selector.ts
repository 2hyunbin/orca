import type { DiffComment } from '../../../shared/diff-comment-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
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

/** One twin of a worktree id, as the owner index tells rows apart: its host and its paired server. */
export type DiffCommentTwin = { hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }

function twinOf(row: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>): DiffCommentTwin {
  const runtimeOwnerEnvironmentId = row.runtimeOwnerEnvironmentId?.trim()
  return {
    ...(row.hostId ? { hostId: row.hostId } : {}),
    ...(runtimeOwnerEnvironmentId ? { runtimeOwnerEnvironmentId } : {})
  }
}

function isTwin(row: Worktree, twin: DiffCommentTwin): boolean {
  const own = twinOf(row)
  return (
    own.hostId === twin.hostId && own.runtimeOwnerEnvironmentId === twin.runtimeOwnerEnvironmentId
  )
}

/** `twin` and `hostId` only for a twin: the write's target and the host it names. */
export type DiffCommentRows = {
  twin?: DiffCommentTwin
  hostId?: ExecutionHostId
  worktrees: readonly Worktree[]
}

/**
 * The host a twin's write names: an SSH target names itself (a paired server proxying it is found
 * from there); a paired server's own row goes through that server.
 */
export function diffCommentTwinHostId(twin: DiffCommentTwin): ExecutionHostId | undefined {
  return twin.runtimeOwnerEnvironmentId && (!twin.hostId || twin.hostId === LOCAL_EXECUTION_HOST_ID)
    ? toRuntimeExecutionHostId(twin.runtimeOwnerEnvironmentId)
    : twin.hostId
}

/**
 * The rows whose review notes a change reads or writes. `twin` is set only when two hosts publish
 * the id; otherwise every row of the id is the one worktree, exactly as before twins existed. A
 * twin is picked by, in order: the twin a queued write captured; the one twin holding the notes the
 * change names (UUIDs, so an async delivery still finds its copy after navigation); the open
 * workspace's host. Nothing else guesses.
 */
export function findDiffCommentRows(
  state: Pick<
    DiffCommentSelectorState,
    'worktreesByRepo' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  worktreeId: string,
  hint: { twin?: DiffCommentTwin; commentIds?: ReadonlySet<string> } = {}
): DiffCommentRows | null {
  const rows = (state.worktreesByRepo[getRepoIdFromWorktreeId(worktreeId)] ?? []).filter(
    (row) => row.id === worktreeId
  )
  const { twin: captured, commentIds } = hint
  if (captured) {
    const worktrees = rows.filter((row) => isTwin(row, captured))
    return worktrees.length > 0 ? { twin: captured, worktrees } : null
  }
  if (rows.length === 0) {
    return null
  }
  const pickTwin = (row: Worktree | undefined, named?: ExecutionHostId): DiffCommentRows | null => {
    if (!row) {
      return null
    }
    const twin = twinOf(row)
    // Why: an unstamped row the selection names is on that host; the write says so to main.
    const hostId = diffCommentTwinHostId(twin) ?? named
    return {
      twin,
      ...(hostId ? { hostId } : {}),
      worktrees: rows.filter((candidate) => isTwin(candidate, twin))
    }
  }
  if (rows.every((row) => isTwin(row, twinOf(rows[0])))) {
    return { worktrees: rows }
  }
  const holders = commentIds?.size
    ? rows.filter((row) => row.diffComments?.some((comment) => commentIds.has(comment.id)))
    : []
  if (holders.length > 0 && holders.every((row) => isTwin(row, twinOf(holders[0])))) {
    return pickTwin(holders[0])
  }
  const named = namedHostForOwnerRef(state, { workspaceId: worktreeId })
  const owner = named
    ? findIndexedWorktreeOwnerForHost(state.worktreesByRepo, worktreeId, named)
    : null
  return pickTwin(
    rows.find((row) => row === owner),
    named ?? undefined
  )
}

/** The notes of those rows; the last duplicate wins, as in the id index the rest of the app reads. */
export function diffCommentRowNotes(found: {
  worktrees: readonly Worktree[]
}): DiffComment[] | undefined {
  return found.worktrees.at(-1)?.diffComments
}

/** What a queued write sends: its twin's latest notes, else the id's first row as before twins. */
export function readQueuedDiffComments(
  state: Pick<
    DiffCommentSelectorState,
    'worktreesByRepo' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  worktreeId: string,
  twin: DiffCommentTwin | undefined
): { list: DiffComment[] | undefined } | null {
  if (!twin) {
    const rows = state.worktreesByRepo[getRepoIdFromWorktreeId(worktreeId)] ?? []
    return { list: rows.find((row) => row.id === worktreeId)?.diffComments }
  }
  const found = findDiffCommentRows(state, worktreeId, { twin })
  return found ? { list: diffCommentRowNotes(found) } : null
}

/** The list a change naming these notes would edit; see {@link findDiffCommentRows}. */
export function readDiffCommentsForChange(
  state: DiffCommentSelectorState,
  worktreeId: string,
  commentIds: Iterable<string>
): DiffComment[] {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return findFolderWorkspaceOwner(state, scope.folderWorkspaceId)?.diffComments ?? []
  }
  const found = findDiffCommentRows(state, worktreeId, { commentIds: new Set(commentIds) })
  return (found && diffCommentRowNotes(found)) ?? []
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
    ? findDiffCommentRows(state, worktreeId)
    : null
  return open
    ? diffCommentRowNotes(open)
    : getIndexedWorktreeById(state.worktreesByRepo, worktreeId)?.diffComments
}

export function selectWorktreeDiffCommentsOrEmpty(
  state: Parameters<typeof selectWorktreeDiffComments>[0],
  worktreeId: string | null | undefined
): DiffComment[] {
  return selectWorktreeDiffComments(state, worktreeId) ?? EMPTY_DIFF_COMMENTS
}
