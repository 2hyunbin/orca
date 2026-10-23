import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import { findWorkspaceFileRoute } from './runtime-workspace-file-route'

type OwnerScopedFile = Pick<
  OpenFile,
  | 'worktreeId'
  | 'filePath'
  | 'relativePath'
  | 'readOnly'
  | 'liveTail'
  | 'runtimeEnvironmentId'
  | 'terminalArtifactGrantId'
  | 'externalSshTargetId'
>

/**
 * The workspace an open file's reads and watch go through. A read-only view
 * of a file another workspace on its host holds (#32158) lives in one workspace but is scoped to
 * the one that holds the file, derived from the catalog so a restored view needs nothing stored.
 */
export function openFileOwnerScope(
  file: OwnerScopedFile,
  state: AppState
): { worktreeId: string; relativePath: string } {
  const own = { worktreeId: file.worktreeId, relativePath: file.relativePath }
  // Why: only a read-only absolute view may sit outside the workspace holding its file; a live-tail
  // log follows itself and must not pull in a recursive watch of a folder that holds it.
  if (
    file.readOnly !== true ||
    file.liveTail === true ||
    file.relativePath !== file.filePath ||
    file.terminalArtifactGrantId ||
    // Why: a direct SSH host's paths are never matched against this computer's catalog.
    file.externalSshTargetId ||
    isFloatingWorkspaceId(file.worktreeId)
  ) {
    return own
  }
  const runtimeOwner = file.runtimeEnvironmentId?.trim()
  const route = findWorkspaceFileRoute(
    state,
    runtimeOwner ? toRuntimeExecutionHostId(runtimeOwner) : LOCAL_EXECUTION_HOST_ID,
    file.filePath
  )
  return route ? { worktreeId: route.worktreeId, relativePath: route.relativePath } : own
}

/** The workspace an open file is scoped to; without a catalog, the one it lives in. */
export function openFileOwnerWorktreeId(
  file: OwnerScopedFile,
  state: AppState | undefined
): string {
  return state ? openFileOwnerScope(file, state).worktreeId : file.worktreeId
}
