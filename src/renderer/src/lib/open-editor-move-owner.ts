import type { OpenFile } from '@/store/slices/editor'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import {
  getExecutionHostIdForWorktree,
  runtimeEnvironmentIdWithLegacyFallbackUnlessTwin
} from './worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

/**
 * Who a file lives on: the paired server (null for this app) and, when known, the SSH host behind
 * it (null for that runtime's own machine, undefined when nothing recorded it).
 */
type FileOwner = { runtimeEnvironmentId: string | null; sshHostId: string | null | undefined }

/** The host a move ran on, from the route its rename was sent through. */
export type EditorMoveOwner = FileOwner & {
  /** The worktree's resolved host, for tabs that recorded no owner of their own. */
  worktreeHostId: string
}

export function editorMoveOwnerFromContext(
  state: WorktreeRuntimeOwnerState,
  context: Pick<RuntimeFileOperationArgs, 'target' | 'expectedExecutionHostId'>,
  worktreeId: string | undefined
): EditorMoveOwner {
  const expected = context.expectedExecutionHostId
  return {
    runtimeEnvironmentId:
      context.target.kind === 'environment' ? context.target.environmentId : null,
    sshHostId: expected === undefined ? undefined : expected === 'local' ? null : expected,
    worktreeHostId: getExecutionHostIdForWorktree(state, worktreeId)
  }
}

/** The tab's own owner, captured when it opened; never re-derived from its worktree id alone. */
function openFileOwner(
  state: WorktreeRuntimeOwnerState,
  file: Pick<
    OpenFile,
    'externalSshTargetId' | 'operationProvenance' | 'runtimeEnvironmentId' | 'worktreeId'
  >
): FileOwner {
  const captured = file.operationProvenance?.generation.route
  if (captured) {
    const host = captured.executionHostId
    return {
      runtimeEnvironmentId: captured.runtimeEnvironmentId,
      sshHostId: host?.startsWith('ssh:') ? host : host ? null : undefined
    }
  }
  return {
    runtimeEnvironmentId:
      file.runtimeEnvironmentId !== undefined
        ? file.runtimeEnvironmentId?.trim() || null
        : runtimeEnvironmentIdWithLegacyFallbackUnlessTwin(state, file.worktreeId),
    sshHostId: file.externalSshTargetId ? toSshExecutionHostId(file.externalSshTargetId) : undefined
  }
}

/**
 * Whether an open tab is the file the move renamed. Why its own owner: the same path open from a
 * same-id workspace on another host is a different file, and its draft must stay where it is.
 */
export function isOpenFileOnMoveOwner(
  state: WorktreeRuntimeOwnerState,
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
  return getExecutionHostIdForWorktree(state, file.worktreeId) === owner.worktreeHostId
}
