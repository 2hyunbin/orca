// Host deletion needs bounded Windows lock retries and unpatched fs for Electron’s .asar handling.

import { win32 } from 'node:path'
import { asarTransparentTreeRemovalFs, rm } from './asar-transparent-fs'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { isWslUncPath } from '../shared/wsl-paths'
import { removeTreeWithBoundedRetries } from '../shared/bounded-tree-removal'

const WINDOWS_REMOVE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000]

/** Convert a native host filesystem path to the Win32 long-path namespace. */
export function toHostFilesystemPath(targetPath: string): string {
  // WSL callers supply POSIX paths even on Windows; do not interpret them as drive-relative paths.
  return process.platform === 'win32' &&
    isWindowsAbsolutePathLike(targetPath) &&
    !isWslUncPath(targetPath)
    ? win32.toNamespacedPath(targetPath)
    : targetPath
}

export function toHostRemovalPath(targetPath: string): string {
  // Node deletion uses Win32 long paths even after Git has verified the target.
  return toHostFilesystemPath(targetPath)
}

/** Recursively remove a host directory tree, retrying transient Windows locks from one bounded budget. */
export async function removeHostTree(
  targetPath: string,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const removalPath = toHostRemovalPath(targetPath)
  if (process.platform !== 'win32') {
    options.signal?.throwIfAborted()
    await rm(removalPath, { recursive: true, force: true })
    return
  }
  await removeTreeWithBoundedRetries(removalPath, asarTransparentTreeRemovalFs, {
    retryDelaysMs: WINDOWS_REMOVE_RETRY_DELAYS_MS,
    signal: options.signal
  })
}
