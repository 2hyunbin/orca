import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import { findWorkspaceFileRoute } from './runtime-workspace-file-route'
import { editorBufferRouteEpochOf } from '@/store/slices/editor/buffers/editor-buffer-identity-cache'

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

type OwnerScope = { worktreeId: string; relativePath: string }
const ownerScopeCache = new WeakMap<object, { epoch: object; scope: OwnerScope }>()

/** Read-only local views can live outside the file’s workspace; derive watch scope from the current catalog so restored tabs need no saved owner (#32158). */
export function openFileOwnerScope(file: OwnerScopedFile, state: AppState): OwnerScope {
  const own = { worktreeId: file.worktreeId, relativePath: file.relativePath }
  // Only read-only absolute views can borrow another workspace watch; live-tail logs must not acquire recursive folder watches.
  if (
    file.readOnly !== true ||
    file.liveTail === true ||
    file.relativePath !== file.filePath ||
    file.terminalArtifactGrantId ||
    // Only local files get outside-workspace views; remote tabs are relocated to their file’s workspace by the loader.
    file.externalSshTargetId ||
    file.runtimeEnvironmentId?.trim() ||
    isFloatingWorkspaceId(file.worktreeId)
  ) {
    return own
  }
  // Why cached: watch selectors run on every store update; the catalog walk only on route changes.
  const epoch = editorBufferRouteEpochOf(state)
  const cached = ownerScopeCache.get(file)
  if (cached?.epoch === epoch) {
    return cached.scope
  }
  const route = findWorkspaceFileRoute(state, LOCAL_EXECUTION_HOST_ID, file.filePath)
  const scope = route ? { worktreeId: route.worktreeId, relativePath: route.relativePath } : own
  ownerScopeCache.set(file, { epoch, scope })
  return scope
}

export function openFileOwnerWorktreeId(
  file: OwnerScopedFile,
  state: AppState | undefined
): string {
  return state ? openFileOwnerScope(file, state).worktreeId : file.worktreeId
}
