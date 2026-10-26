// Node's async recursive rm retries every nested entry separately and orphans siblings on rejection, so one
// file held open by another process multiplies work per directory level. One pass per attempt, nothing orphaned.

import { sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export type TreeRemovalFs = {
  lstat: (path: string) => Promise<{ isDirectory: () => boolean }>
  readdir: (path: string) => Promise<string[]>
  unlink: (path: string) => Promise<void>
  rmdir: (path: string) => Promise<void>
  chmod: (path: string, mode: number) => Promise<void>
}

export type BoundedTreeRemovalOptions = {
  /** One delay per extra pass; the pass count is `retryDelaysMs.length + 1`. */
  retryDelaysMs: readonly number[]
  signal?: AbortSignal
}

const LOCKED_ENTRY_CODES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM'])

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? typeof error.code === 'string'
      ? error.code
      : undefined
    : undefined
}

function displayPath(path: string): string {
  return path.replace(/^\\\\\?\\(UNC\\)?/, (_, unc: string | undefined) => (unc ? '\\\\' : ''))
}

function childPath(parent: string, name: string): string {
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`
}

async function removeFile(path: string, fs: TreeRemovalFs, failures: unknown[]): Promise<boolean> {
  try {
    await fs.unlink(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return true
    }
    if (errorCode(error) !== 'EPERM') {
      failures.push(error)
      return false
    }
  }
  // Windows reports a read-only file as EPERM; clear the bit once like Node's rimraf.
  try {
    await fs.chmod(path, 0o666)
    await fs.unlink(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return true
    }
    failures.push(error)
    return false
  }
}

/** Resolves true when `path` is gone; never rejects, so a parent always awaits every child. */
async function removeEntry(
  path: string,
  fs: TreeRemovalFs,
  failures: unknown[],
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (signal?.aborted) {
    return false
  }
  let names: string[]
  try {
    // lstat reports junctions and symlinks as non-directories, so unlink never follows them.
    if (!(await fs.lstat(path)).isDirectory()) {
      return await removeFile(path, fs, failures)
    }
    names = await fs.readdir(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return true
    }
    failures.push(error)
    return false
  }
  const removed = await Promise.all(
    names.map((name) => removeEntry(childPath(path, name), fs, failures, signal))
  )
  if (!removed.every(Boolean) || signal?.aborted) {
    return false
  }
  try {
    await fs.rmdir(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return true
    }
    failures.push(error)
    return false
  }
}

export class TreeRemovalError extends Error {
  readonly code: string | undefined
  readonly path: string | undefined
  readonly failures: readonly unknown[]

  constructor(root: string, failures: readonly unknown[]) {
    const first = failures[0]
    const firstPath =
      typeof first === 'object' &&
      first !== null &&
      'path' in first &&
      typeof first.path === 'string'
        ? first.path
        : undefined
    const inUse = failures.every((failure) => errorCode(failure) === 'EBUSY')
    const reason = inUse
      ? 'another process has them open; close it and retry'
      : first instanceof Error
        ? first.message
        : String(first)
    super(
      `Could not delete ${failures.length} item${failures.length === 1 ? '' : 's'} in ${displayPath(root)}` +
        `${firstPath ? ` (first: ${displayPath(firstPath)})` : ''}: ${reason}`,
      { cause: first }
    )
    this.name = 'TreeRemovalError'
    this.code = errorCode(first)
    this.path = firstPath
    this.failures = failures
  }
}

/** Recursively delete `root`; the whole tree costs at most one pass per allowed attempt. */
export async function removeTreeWithBoundedRetries(
  root: string,
  fs: TreeRemovalFs,
  options: BoundedTreeRemovalOptions
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const failures: unknown[] = []
    const removed = await removeEntry(root, fs, failures, options.signal)
    options.signal?.throwIfAborted()
    if (removed) {
      return
    }
    const retryable = failures.every((failure) => LOCKED_ENTRY_CODES.has(errorCode(failure) ?? ''))
    if (attempt >= options.retryDelaysMs.length || !retryable) {
      throw new TreeRemovalError(root, failures)
    }
    await delay(options.retryDelaysMs[attempt], undefined, { signal: options.signal }).catch(
      (error: unknown) => {
        throw options.signal?.aborted ? options.signal.reason : error
      }
    )
  }
}
