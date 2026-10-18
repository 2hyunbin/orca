import { getWorktreeIdFromVisitKey } from '@/lib/worktree-visit-recency'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'

/**
 * Previously-active workspaces that keep their full-tree watch, so switching
 * back is instant. Every other background workspace with open tabs gets a
 * narrow watch of just those files' directories.
 */
export const WARM_RECURSIVE_WATCH_WORKSPACE_COUNT = 3

/** The active workspace plus the most recently visited ones (an LRU over focus recency). */
export function selectRecursiveWatchWorkspaceIds(
  activeWorktreeId: string | null,
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>> | undefined
): ReadonlySet<string> {
  const ids = new Set<string>()
  if (activeWorktreeId) {
    ids.add(activeWorktreeId)
  }
  // Why top-k instead of a full sort: this runs on every target recompute and the map grows with history.
  const warm: { id: string; visitedAt: number }[] = []
  for (const [key, visitedAt] of Object.entries(lastVisitedAtByWorktreeId ?? {})) {
    const id = getWorktreeIdFromVisitKey(key)
    if (id === activeWorktreeId) {
      continue
    }
    const existing = warm.find((entry) => entry.id === id)
    if (existing) {
      existing.visitedAt = Math.max(existing.visitedAt, visitedAt)
    } else {
      warm.push({ id, visitedAt })
    }
    warm.sort((left, right) => right.visitedAt - left.visitedAt)
    warm.length = Math.min(warm.length, WARM_RECURSIVE_WATCH_WORKSPACE_COUNT)
  }
  for (const entry of warm) {
    ids.add(entry.id)
  }
  return ids
}

/**
 * Worktree-relative paths a narrow watch can cover, or null when a tab has no
 * file inside the workspace (the caller then keeps the full-tree watch).
 */
export function toNarrowWatchFiles(relativePaths: Iterable<string>): string[] | null {
  const files = new Set<string>()
  for (const relativePath of relativePaths) {
    const segments = relativePath.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
    if (
      segments.length === 0 ||
      segments.includes('..') ||
      /^([\\/]|[a-zA-Z]:)/.test(relativePath)
    ) {
      return null
    }
    // Why raw: main splits by its own platform's separator rules.
    files.add(relativePath)
  }
  return files.size > 0 ? [...files].sort() : null
}

/** Null wins: a consumer that needs the whole tree (the sidebar) keeps the target recursive. */
export function mergeRelativePaths(left: string[] | null, right: string[] | null): string[] | null {
  return left && right ? [...left, ...right] : null
}

/** Only local background workspaces narrow; SSH and runtime hosts have no narrow watch mode yet. */
export function scopeEditorExternalWatchTargets(
  targetsByKey: ReadonlyMap<string, EditorExternalWatchTarget>,
  relativePathsByKey: ReadonlyMap<string, string[] | null>,
  recursiveWorkspaceIds: ReadonlySet<string>,
  getTargetKey: (target: EditorExternalWatchTarget) => string
): Map<string, EditorExternalWatchTarget> {
  const scoped = new Map<string, EditorExternalWatchTarget>()
  for (const [key, target] of targetsByKey) {
    const relativePaths = relativePathsByKey.get(key) ?? null
    const narrowFiles =
      recursiveWorkspaceIds.has(target.worktreeId) ||
      target.connectionId !== undefined ||
      target.runtimeEnvironmentId !== null ||
      !relativePaths
        ? null
        : toNarrowWatchFiles(relativePaths)
    if (!narrowFiles) {
      scoped.set(key, target)
      continue
    }
    const narrowTarget = { ...target, narrowFiles }
    scoped.set(getTargetKey(narrowTarget), narrowTarget)
  }
  return scoped
}
