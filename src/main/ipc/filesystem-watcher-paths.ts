import * as path from 'node:path'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { toNarrowLocalWatcherKey } from './filesystem-watcher-narrow-roots'

// ── Path normalization ───────────────────────────────────────────────

function normalizeWatcherRootPath(rootPath: string): string {
  let resolved = isWindowsAbsolutePathLike(rootPath)
    ? path.win32.resolve(rootPath)
    : path.resolve(rootPath)
  // Why: Windows watcher events may use lowercase drive letters vs stored uppercase; normalize so renderer casing stays consistent (§4.4).
  if (/^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}

export function getLocalWatcherRoot(
  rootPath: string,
  narrowFiles?: readonly string[]
): { key: string; path: string } {
  const normalizedPath = normalizeWatcherRootPath(rootPath)
  // Why: Windows drive/UNC paths are case-insensitive; cleanup must match the owner even when Git returns a different spelling.
  const key = normalizeRuntimePathForComparison(normalizedPath)
  return {
    key: narrowFiles ? toNarrowLocalWatcherKey(key, narrowFiles) : key,
    path: normalizedPath
  }
}

export function normalizeWatcherEventPath(eventPath: string): string {
  let resolved = path.resolve(eventPath)
  if (/^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}

export function getRemoteWatcherKey(connectionId: string, worktreePath: string): string {
  return JSON.stringify([connectionId, normalizeRuntimePathForComparison(worktreePath)])
}
