import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { WatchWorktreeArgs, WatchWorktreeStatus } from '../../../shared/filesystem-entry-types'
import {
  getEditorExternalWatchTargetKey,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'

/** Old watches kept alive (by replacement target key) because their replacement never installed. */
export type HeldEditorWatches = Map<string, EditorExternalWatchTarget[]>

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

// Why: older preload/web stubs resolve with no status; they never had a pending state.
export function isWatchInstalled(status: WatchWorktreeStatus | undefined): boolean {
  return status === undefined || status === 'installed'
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
function releaseMainProcessWatch(
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

/** Releases a target plus any older watches it was keeping alive. */
export function releaseEditorWatch(
  target: EditorExternalWatchTarget,
  currentTargets: readonly EditorExternalWatchTarget[],
  held: HeldEditorWatches
): void {
  const key = getEditorExternalWatchTargetKey(target)
  const riders = held.get(key) ?? []
  held.delete(key)
  for (const watch of [target, ...riders]) {
    releaseMainProcessWatch(watch, currentTargets)
  }
}

/** Keeps `old` (and what it was holding) alive until `replacement` itself is released. */
export function holdEditorWatchUntilReleased(
  old: EditorExternalWatchTarget,
  replacement: EditorExternalWatchTarget,
  held: HeldEditorWatches
): void {
  const oldKey = getEditorExternalWatchTargetKey(old)
  const replacementKey = getEditorExternalWatchTargetKey(replacement)
  const riders = held.get(oldKey) ?? []
  held.delete(oldKey)
  held.set(replacementKey, [...(held.get(replacementKey) ?? []), old, ...riders])
}
