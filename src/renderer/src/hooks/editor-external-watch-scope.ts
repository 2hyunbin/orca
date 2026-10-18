import { getWorktreeIdFromVisitKey } from '@/lib/worktree-visit-recency'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'

// Why: recently active workspaces keep the full-tree watch so switching back is instant.
export const WARM_RECURSIVE_WATCH_WORKSPACE_COUNT = 3

// Why: an LRU over focus recency; `exists` keeps deleted workspaces from holding warm slots.
export function selectRecursiveWatchWorkspaceIds(
  activeWorktreeId: string | null,
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>> | undefined,
  exists: (workspaceId: string) => boolean
): ReadonlySet<string> {
  const ids = new Set<string>()
  if (activeWorktreeId) {
    ids.add(activeWorktreeId)
  }
  // Why top-k instead of a full sort: this runs on every target recompute and the map grows with history.
  const warm: { id: string; visitedAt: number }[] = []
  for (const [key, visitedAt] of Object.entries(lastVisitedAtByWorktreeId ?? {})) {
    const id = getWorktreeIdFromVisitKey(key)
    if (id === activeWorktreeId || !exists(id)) {
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

// Why null: a tab outside the workspace can only be covered by the full-tree watch.
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

// Why null wins: a consumer that needs the whole tree (the sidebar) keeps the target recursive.
export function mergeRelativePaths(left: string[] | null, right: string[] | null): string[] | null {
  return left && right ? [...left, ...right] : null
}

// Why: SSH and runtime hosts have no narrow mode, and the WSL poller has no per-file mode either.
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
      isWslUncPath(target.worktreePath) ||
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
