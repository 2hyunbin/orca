import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { WatchWorktreeArgs } from '../../../shared/filesystem-entry-types'
import {
  getEditorExternalWatchTargetKey,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'

/** Same workspace on the same host, whether watched recursively or narrowly. */
export function getEditorExternalWatchScopeKey(target: EditorExternalWatchTarget): string {
  return getEditorExternalWatchTargetKey({ ...target, narrowFiles: undefined })
}

export function toWatchWorktreeArgs(target: EditorExternalWatchTarget): WatchWorktreeArgs {
  return {
    worktreePath: target.worktreePath,
    connectionId: target.connectionId,
    ...(target.narrowFiles ? { narrowFiles: target.narrowFiles } : {})
  }
}

// Why: main shares one subscription per (host, root, narrow set) per window, so a distinct renderer key can still name it.
function getMainProcessWatchIdentity(target: EditorExternalWatchTarget): string {
  return JSON.stringify([
    target.connectionId ?? null,
    normalizeRuntimePathForComparison(target.worktreePath),
    target.narrowFiles ?? null
  ])
}

/** Unwatch a local/SSH target unless a current target still owns the same main-process watch. */
export function releaseMainProcessWatch(
  target: EditorExternalWatchTarget,
  currentTargets: readonly EditorExternalWatchTarget[]
): void {
  const identity = getMainProcessWatchIdentity(target)
  if (
    currentTargets.some(
      (current) =>
        !current.runtimeEnvironmentId && getMainProcessWatchIdentity(current) === identity
    )
  ) {
    return
  }
  void window.api.fs.unwatchWorktree(toWatchWorktreeArgs(target))
}
