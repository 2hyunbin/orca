import * as path from 'node:path'

// Why: NUL can never appear in a path, so a narrow key cannot collide with a recursive root key.
const NARROW_KEY_MARKER = '\0narrow\0'
const NARROW_KEY_SEPARATOR = '\0'

/**
 * Validates renderer-supplied open-file paths for a narrow (non-recursive) watch.
 * Returns undefined when the request is a full recursive watch.
 */
export function normalizeNarrowWatchFiles(files: unknown): string[] | undefined {
  if (!Array.isArray(files)) {
    return undefined
  }
  const separator = process.platform === 'win32' ? /[\\/]+/ : /\/+/
  const normalized = new Set<string>()
  for (const file of files) {
    if (typeof file !== 'string' || file.includes('\0') || path.isAbsolute(file)) {
      continue
    }
    const segments = file.split(separator).filter((segment) => segment !== '' && segment !== '.')
    if (segments.length === 0 || segments.includes('..')) {
      continue
    }
    normalized.add(segments.join('/'))
  }
  return [...normalized].sort()
}

export function toNarrowLocalWatcherKey(baseKey: string, narrowFiles: readonly string[]): string {
  return `${baseKey}${NARROW_KEY_MARKER}${narrowFiles.join(NARROW_KEY_SEPARATOR)}`
}

export function parseLocalWatcherKey(key: string): {
  baseKey: string
  narrowFiles?: string[]
} {
  const markerIndex = key.indexOf(NARROW_KEY_MARKER)
  if (markerIndex === -1) {
    return { baseKey: key }
  }
  const files = key.slice(markerIndex + NARROW_KEY_MARKER.length)
  return {
    baseKey: key.slice(0, markerIndex),
    narrowFiles: files === '' ? [] : files.split(NARROW_KEY_SEPARATOR)
  }
}

/** The recursive key for a worktree plus every narrow key watching inside it. */
export function collectLocalWatcherKeysForBase(
  baseKey: string,
  keySources: Iterable<Iterable<string>>
): string[] {
  const keys = new Set<string>([baseKey])
  for (const source of keySources) {
    for (const key of source) {
      if (key.startsWith(`${baseKey}${NARROW_KEY_MARKER}`)) {
        keys.add(key)
      }
    }
  }
  return [...keys]
}
