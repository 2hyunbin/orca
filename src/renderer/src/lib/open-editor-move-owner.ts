import type { OpenFile } from '@/store/slices/editor'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { authorityKey, SELF_LOCAL_AUTHORITY } from '../../../shared/host-authority'
import { resolveOwner } from './resolve-owner'
import type { WorktreeOperationRouteState } from './worktree-operation-route'

/**
 * Who a file lives on: the paired server (null for this app) and, when known, the SSH host behind
 * it (null for that runtime's own machine, undefined when nothing decisive recorded it).
 */
type FileOwner = { runtimeEnvironmentId: string | null; sshHostId: string | null | undefined }

/** The host a move ran on, from the route its rename was sent through. */
export type EditorMoveOwner = FileOwner & {
  /** The renamed workspace, for tabs that recorded no decisive owner of their own. */
  worktreeId: string | undefined
}

export function editorMoveOwnerFromContext(
  context: Pick<RuntimeFileOperationArgs, 'target' | 'expectedExecutionHostId'>,
  worktreeId: string | undefined
): EditorMoveOwner {
  const expected = parseExecutionHostId(context.expectedExecutionHostId)
  return {
    runtimeEnvironmentId:
      context.target.kind === 'environment' ? context.target.environmentId : null,
    sshHostId:
      expected?.kind === 'ssh' ? expected.id : expected?.kind === 'local' ? null : undefined,
    worktreeId
  }
}

/**
 * The tab's own owner, recorded when it opened; never re-derived from its worktree id alone. Only an
 * SSH host it names is decisive: a `local` or server route can be this app's view of a host the
 * File Explorer resolves further (an unstamped folder of SSH repos, a server's nested SSH target).
 */
function openFileOwner(
  state: WorktreeOperationRouteState,
  file: Pick<
    OpenFile,
    'externalSshTargetId' | 'operationProvenance' | 'runtimeEnvironmentId' | 'worktreeId'
  >
): FileOwner {
  const captured = file.operationProvenance?.generation.route
  const capturedHost = parseExecutionHostId(captured?.executionHostId)
  const runtimeEnvironmentId =
    file.runtimeEnvironmentId !== undefined
      ? file.runtimeEnvironmentId?.trim() || null
      : captured
        ? captured.runtimeEnvironmentId
        : ownerEnvironmentId(state, file.worktreeId)
  return {
    runtimeEnvironmentId,
    sshHostId:
      capturedHost?.kind === 'ssh'
        ? capturedHost.id
        : file.externalSshTargetId
          ? toSshExecutionHostId(file.externalSshTargetId)
          : undefined
  }
}

/**
 * Whether an open tab is the file the move renamed. Why its own owner: the same path open from a
 * same-id workspace on another host is a different file, and its draft must stay where it is.
 */
export function isOpenFileOnMoveOwner(
  state: WorktreeOperationRouteState,
  file: Pick<
    OpenFile,
    'externalSshTargetId' | 'operationProvenance' | 'runtimeEnvironmentId' | 'worktreeId'
  >,
  owner: EditorMoveOwner
): boolean {
  const own = openFileOwner(state, file)
  if (own.runtimeEnvironmentId !== owner.runtimeEnvironmentId) {
    return false
  }
  if (own.sshHostId !== undefined && owner.sshHostId !== undefined) {
    return own.sshHostId === owner.sshHostId
  }
  // Why the rows, read now: a lookup from before the rename, or one following focus, can disagree.
  if (file.worktreeId === owner.worktreeId) {
    return true
  }
  const tabHost = workspaceHostKey(state, file.worktreeId)
  return tabHost !== null && tabHost === workspaceHostKey(state, owner.worktreeId)
}

/** A workspace's host from its rows; one without rows is this app's, as everywhere; a twin has none. */
function workspaceHostKey(
  state: WorktreeOperationRouteState,
  workspaceId: string | undefined
): string | null {
  const match = workspaceId ? resolveOwner(state, { workspaceId }) : null
  if (match?.kind === 'ambiguous') {
    return null
  }
  return authorityKey(match?.kind === 'resolved' ? match.owner : SELF_LOCAL_AUTHORITY)
}

/** The paired server a workspace's rows name, or null for this app, a twin or no row. */
function ownerEnvironmentId(
  state: WorktreeOperationRouteState,
  workspaceId: string
): string | null {
  const match = resolveOwner(state, { workspaceId })
  return match.kind === 'resolved' && match.owner.endpoint.kind === 'environment'
    ? match.owner.endpoint.environmentId
    : null
}
